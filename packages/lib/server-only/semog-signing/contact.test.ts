import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createSemogContactHandler } from './contact-http';
import {
  createSemogContactFixture,
  createSemogSigningAfterContact,
  SEMOG_CONTACT_KEY,
  SEMOG_HASH_CONSENT,
  SEMOG_HASH_DOCUMENT,
} from './contact-test-fixtures';

const body = { chaveOperacao: SEMOG_CONTACT_KEY, recipientId: 21, email: '  Novo.Endereco@Example.ORG ' };
const refusal = (codigo: string, destinatarios?: { recipientId: number; motivo: string }[]) => ({
  statusCode: 409,
  semogRefusal: destinatarios ? { codigo, destinatarios } : { codigo },
});

describe('Semog signer contact change', () => {
  it('changes the e-mail, revokes every live missing enrollment and re-enrolls the unexpired ones', async () => {
    const fixture = createSemogContactFixture();
    const result = await fixture.service.create(fixture.actor, 'env', body);
    expect(result).toEqual({
      chaveOperacao: SEMOG_CONTACT_KEY,
      envelopeId: 'env',
      recipientId: 21,
      email: 'novo.endereco@example.org',
      revogados: [21, 22, 23],
      reinscritos: [21, 22],
    });
    expect(fixture.envelope.recipients.find((r) => r.id === 21)?.email).toBe('novo.endereco@example.org');
    // The signer's own enrollment (20) is untouched; the expired one (23) stays revoked.
    const live = fixture.state.snapshots.filter((s) => s.revogadaEm === null).map((s) => s.recipientId);
    expect(live.sort()).toEqual([20, 21, 22]);
    for (const snapshot of fixture.state.registered) {
      expect(snapshot.hashDocumento).toBe(SEMOG_HASH_DOCUMENT);
      expect(snapshot.hashConsentimento).toBe(SEMOG_HASH_CONSENT);
      expect(snapshot.expiraEm).toBe('2098-01-01T00:00:00.000Z');
      expect(snapshot.conteudo).toMatchObject({ consentimento: 'Li e concordo.' });
    }
    expect(fixture.state.audits).toMatchObject([
      {
        data: {
          type: 'RECIPIENT_UPDATED',
          userId: 2,
          data: {
            recipientId: 21,
            recipientEmail: 'novo.endereco@example.org',
            changes: [{ type: 'EMAIL', from: 'r21@example.org', to: 'novo.endereco@example.org' }],
          },
        },
      },
    ]);
    expect(fixture.transactions[0]).toMatchObject({ isolationLevel: 'ReadCommitted' });
  });

  it('keeps existing links working: the unchanged signing path accepts the re-enrolled snapshot', async () => {
    const fixture = createSemogContactFixture();
    await fixture.service.create(fixture.actor, 'env', body);
    const signing = createSemogSigningAfterContact(fixture);
    for (const recipientId of [21, 22]) {
      // The Semog app only ever sends what it already had from the first enrollment.
      await signing.service.reserve(fixture.actor, {
        chaveOperacao: `1a2b3c4d-0000-4000-8000-0000000000${recipientId}`,
        envelopeId: 'env',
        recipientId,
        hashDocumento: SEMOG_HASH_DOCUMENT,
        hashConsentimento: SEMOG_HASH_CONSENT,
        acao: 'assinar',
        motivo: null,
        campos: [{ fieldId: recipientId * 10, valor: `Conselheiro ${recipientId}` }],
        evidencias: {
          canal: 'email',
          identificacaoId: 'contato',
          confirmadoEm: '2026-10-29T12:00:00Z',
          ip: null,
          userAgent: null,
        },
      });
    }
    expect(signing.repository.reserveOperation).toHaveBeenCalledTimes(2);
  });

  it('replays the same key and body without writing again', async () => {
    const fixture = createSemogContactFixture();
    const first = await fixture.service.create(fixture.actor, 'env', body);
    const again = await fixture.service.create(fixture.actor, 'env', { ...body, email: 'novo.endereco@example.org' });
    expect(again).toEqual(first);
    expect(fixture.tx.recipient.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.state.audits).toHaveLength(1);
  });

  it('refuses a reused key with a different body, and a key taken concurrently elsewhere', async () => {
    const fixture = createSemogContactFixture();
    await fixture.service.create(fixture.actor, 'env', body);
    await expect(
      fixture.service.create(fixture.actor, 'env', { ...body, email: 'outro@example.org' }),
    ).rejects.toMatchObject(refusal('chave-reutilizada'));
    const racing = createSemogContactFixture();
    racing.tx.$executeRaw.mockImplementationOnce(() =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError('duplicate key', {
          code: 'P2010',
          clientVersion: 'test',
          meta: { code: '23505' },
        }),
      ),
    );
    await expect(racing.service.create(racing.actor, 'env', body)).rejects.toMatchObject(refusal('chave-reutilizada'));
  });

  const refuse = async (
    change: (fixture: ReturnType<typeof createSemogContactFixture>) => void,
    input: Record<string, unknown>,
    expected: Record<string, unknown>,
    actor = { teamId: 1, userId: 2 },
  ) => {
    const fixture = createSemogContactFixture();
    change(fixture);
    await expect(fixture.service.create(actor, 'env', { ...body, ...input })).rejects.toMatchObject(expected);
    expect(fixture.tx.recipient.updateMany).not.toHaveBeenCalled();
    expect(fixture.state.receipts).toHaveLength(0);
    expect(fixture.state.snapshots.every((s) => s.revogadaEm === null)).toBe(true);
    expect(fixture.state.audits).toHaveLength(0);
  };
  it('refuses a signer who already signed, a CC and an unknown recipient', async () => {
    await refuse(
      () => undefined,
      { recipientId: 20 },
      refusal('destinatarios-inelegiveis', [{ recipientId: 20, motivo: 'ja-assinou' }]),
    );
    await refuse(
      () => undefined,
      { recipientId: 24 },
      refusal('destinatarios-inelegiveis', [{ recipientId: 24, motivo: 'nao-signatario' }]),
    );
    await refuse(
      () => undefined,
      { recipientId: 99 },
      refusal('destinatarios-inelegiveis', [{ recipientId: 99, motivo: 'nao-encontrado' }]),
    );
  });
  it('refuses an unchanged e-mail and one used by another recipient of the envelope', async () => {
    await refuse(
      () => undefined,
      { email: 'R21@example.org' },
      refusal('destinatarios-inelegiveis', [{ recipientId: 21, motivo: 'email-inalterado' }]),
    );
    await refuse(
      () => undefined,
      { email: 'r24@example.org' },
      refusal('destinatarios-inelegiveis', [{ recipientId: 21, motivo: 'email-em-uso' }]),
    );
  });
  it('refuses while a missing signer has an operation in flight, naming them', async () => {
    await refuse(
      (fixture) => fixture.state.operations.push({ recipientId: 22 }, { recipientId: 25 }),
      {},
      refusal('operacao-em-andamento', [
        { recipientId: 22, motivo: 'operacao-existente' },
        { recipientId: 25, motivo: 'operacao-existente' },
      ]),
    );
  });
  it('refuses a non-PENDING envelope and one with a REJECTED recipient', async () => {
    await refuse(
      (fixture) => Object.assign(fixture.envelope, { status: 'COMPLETED' }),
      {},
      refusal('envelope-nao-pendente'),
    );
    await refuse(
      (fixture) => Object.assign(fixture.envelope.recipients[3], { signingStatus: 'REJECTED' }),
      {},
      refusal('envelope-com-recusa'),
    );
  });
  it('refuses another team and an envelope the bridge did not activate without revealing it', async () => {
    await refuse(() => undefined, {}, { statusCode: 404 }, { teamId: 7, userId: 2 });
    await refuse((fixture) => Object.assign(fixture.state, { managed: false }), {}, { statusCode: 404 });
  });
  it('refuses malformed bodies before any transaction', async () => {
    const fixture = createSemogContactFixture();
    for (const invalid of [
      {},
      { ...body, email: 'não é e-mail' },
      { ...body, email: `${'a'.repeat(250)}@example.org` },
      { ...body, recipientId: 0 },
      { ...body, chaveOperacao: 'x' },
      { ...body, name: 'Outro' },
    ]) {
      await expect(fixture.service.create(fixture.actor, 'env', invalid)).rejects.toThrow();
    }
    expect(fixture.transactions).toHaveLength(0);
  });
});

describe('Semog signer contact HTTP boundary', () => {
  const url = 'https://local.invalid/api/semog/v1/envelopes/env/contatos';
  const post = (payload: string, headers: Record<string, string> = {}, target = url) =>
    new Request(target, {
      method: 'POST',
      headers: { authorization: 'Bearer api_0123456789abcdef', 'content-type': 'application/json', ...headers },
      body: payload,
    });
  it('requires bearer, JSON, a bounded body and a well-formed path', async () => {
    const fake = {
      authenticate: vi.fn(async () => ({ teamId: 1, userId: 2 })),
      create: vi.fn(async () => ({
        chaveOperacao: SEMOG_CONTACT_KEY,
        envelopeId: 'env',
        recipientId: 21,
        email: 'novo@example.org',
        revogados: [21],
        reinscritos: [21],
      })),
    };
    const handler = createSemogContactHandler(fake);
    expect((await handler(post(JSON.stringify(body), { authorization: '' }))).status).toBe(401);
    expect((await handler(post(JSON.stringify(body), { 'content-type': 'text/plain' }))).status).toBe(400);
    expect((await handler(post('x'.repeat(4097)))).status).toBe(413);
    expect((await handler(new Request(url, { headers: { authorization: 'Bearer x' } }))).status).toBe(404);
    const malformed = 'https://local.invalid/api/semog/v1/envelopes/env%E0%A4%A/contatos';
    expect((await handler(post(JSON.stringify(body), {}, malformed))).status).toBe(400);
    expect(fake.create).not.toHaveBeenCalled();
    const accepted = await handler(post(JSON.stringify(body)));
    expect(accepted.status).toBe(200);
    expect(fake.create).toHaveBeenCalledWith({ teamId: 1, userId: 2 }, 'env', body);
  });
  it('returns the coded refusal with the recipients in flight', async () => {
    const fixture = createSemogContactFixture();
    fixture.state.operations.push({ recipientId: 22 });
    const response = await createSemogContactHandler(fixture.service)(post(JSON.stringify(body)));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Solicitação não autorizada ou inválida.',
      codigo: 'operacao-em-andamento',
      destinatarios: [{ recipientId: 22, motivo: 'operacao-existente' }],
    });
  });
});
