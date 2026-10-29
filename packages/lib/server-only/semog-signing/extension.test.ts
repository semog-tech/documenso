import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createSemogExtensionHandler } from './extension-http';
import {
  createSemogExtensionFixture,
  SEMOG_CURRENT_EXPIRY,
  SEMOG_EXTENSION_KEY,
  SEMOG_NEW_EXPIRY,
} from './extension-test-fixtures';

const body = { chaveOperacao: SEMOG_EXTENSION_KEY, recipientIds: [14, 10], expiraEm: '2098-12-31T23:59:59.000-03:00' };
const enrollment = (recipientId: number) => ({
  envelopeId: 'env',
  recipientId,
  consentimento: 'Li e concordo.',
  expiraEm: '2098-12-31T23:59:59.000-03:00',
});

describe('Semog deadline extension', () => {
  it('revokes the active snapshots, moves expiresAt, audits, and a new enrollment then passes', async () => {
    const fixture = createSemogExtensionFixture();
    // Before: the new deadline is beyond the recipient's native expiry, so enrollment is refused.
    await expect(fixture.signing.enroll(fixture.actor, enrollment(10))).rejects.toThrow();
    const result = await fixture.service.create(fixture.actor, 'env', body);
    expect(result).toEqual({
      chaveOperacao: SEMOG_EXTENSION_KEY,
      envelopeId: 'env',
      recipientIds: [10, 14],
      expiraEm: '2099-01-01T02:59:59.000Z',
      snapshotsRevogados: 1,
    });
    expect(fixture.state.snapshots.find((s) => s.recipientId === 10)?.revogadaEm).not.toBeNull();
    expect(fixture.state.snapshots.find((s) => s.recipientId === 11)?.revogadaEm).toBeNull();
    const byId = new Map(fixture.envelope.recipients.map((recipient) => [recipient.id, recipient.expiresAt]));
    expect(byId.get(10)).toBe(SEMOG_NEW_EXPIRY);
    expect(byId.get(14)).toBe(SEMOG_NEW_EXPIRY);
    expect(byId.get(13)).toBe(SEMOG_CURRENT_EXPIRY);
    expect(fixture.state.audits).toMatchObject([
      { data: { type: 'RECIPIENT_UPDATED', userId: 2, data: { recipientId: 10, changes: [] } } },
      { data: { type: 'RECIPIENT_UPDATED', userId: 2, data: { recipientId: 14, changes: [] } } },
    ]);
    expect(fixture.transactions[0]).toMatchObject({ isolationLevel: 'ReadCommitted' });
    const enrolled = await fixture.signing.enroll(fixture.actor, enrollment(10));
    expect(enrolled.expiraEm).toBe(SEMOG_NEW_EXPIRY);
  });

  it('replays the same key and body without writing again', async () => {
    const fixture = createSemogExtensionFixture();
    const first = await fixture.service.create(fixture.actor, 'env', body);
    const again = await fixture.service.create(fixture.actor, 'env', { ...body, recipientIds: [10, 14] });
    expect(again).toEqual(first);
    expect(fixture.tx.recipient.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.state.audits).toHaveLength(2);
  });

  it('refuses a reused key with a different body', async () => {
    const fixture = createSemogExtensionFixture();
    await fixture.service.create(fixture.actor, 'env', body);
    await expect(fixture.service.create(fixture.actor, 'env', { ...body, recipientIds: [10] })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      fixture.service.create(fixture.actor, 'env', { ...body, expiraEm: '2098-12-30T23:59:59.000-03:00' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  const refuse = async (
    change: (fixture: ReturnType<typeof createSemogExtensionFixture>) => void,
    input: Record<string, unknown>,
    status: number,
    actor = { teamId: 1, userId: 2 },
  ) => {
    const fixture = createSemogExtensionFixture();
    change(fixture);
    await expect(fixture.service.create(actor, 'env', { ...body, ...input })).rejects.toMatchObject({
      statusCode: status,
    });
    expect(fixture.tx.recipient.updateMany).not.toHaveBeenCalled();
    expect(fixture.state.receipts).toHaveLength(0);
    expect(fixture.state.snapshots.every((s) => s.revogadaEm === null)).toBe(true);
  };
  it('refuses a recipient who already signed', async () => {
    await refuse(() => undefined, { recipientIds: [11] }, 409);
  });
  it('refuses a recipient with an operation in the bridge', async () => {
    await refuse(() => undefined, { recipientIds: [13] }, 409);
  });
  it('refuses a CC recipient', async () => {
    await refuse(() => undefined, { recipientIds: [12] }, 409);
  });
  it('refuses an unknown recipient', async () => {
    await refuse(() => undefined, { recipientIds: [99] }, 409);
  });
  it('refuses a deadline earlier than, equal to, or before now', async () => {
    await refuse(() => undefined, { expiraEm: '2097-12-31T23:59:59.000-03:00' }, 409);
    await refuse(() => undefined, { expiraEm: SEMOG_CURRENT_EXPIRY }, 409);
    await refuse(
      (fixture) => {
        for (const recipient of fixture.envelope.recipients) {
          Object.assign(recipient, { expiresAt: '2020-01-01T00:00:00.000Z' });
        }
      },
      { expiraEm: '2021-01-01T00:00:00.000Z' },
      409,
    );
  });
  it('refuses another team without revealing the envelope', async () => {
    await refuse(() => undefined, {}, 404, { teamId: 7, userId: 2 });
  });
  it('refuses an envelope the bridge did not activate', async () => {
    await refuse((fixture) => Object.assign(fixture.state, { managed: false }), {}, 404);
  });
  it('refuses an envelope that is not PENDING', async () => {
    await refuse((fixture) => Object.assign(fixture.envelope, { status: 'COMPLETED' }), {}, 409);
  });
  it('refuses while a recipient outside the request holds a live enrollment', async () => {
    // expiresAt is part of every snapshot: moving one would break the other's pending signature.
    await refuse(
      (fixture) =>
        fixture.state.snapshots.push({
          id: 's-14',
          recipientId: 14,
          expiraEm: '2098-01-01T00:00:00.000Z',
          revogadaEm: null,
        }),
      { recipientIds: [10] },
      409,
    );
  });
  it('refuses malformed bodies before any transaction', async () => {
    const fixture = createSemogExtensionFixture();
    for (const invalid of [
      {},
      { ...body, recipientIds: [] },
      { ...body, recipientIds: [10, 10] },
      { ...body, recipientIds: [0] },
      { ...body, expiraEm: 'amanhã' },
      { ...body, expiraEm: '2099-01-01T00:00:00' },
      { ...body, chaveOperacao: 'x' },
      { ...body, teamId: 2 },
    ]) {
      await expect(fixture.service.create(fixture.actor, 'env', invalid)).rejects.toThrow();
    }
    expect(fixture.transactions).toHaveLength(0);
  });
});

const refusal = (codigo: string, destinatarios?: { recipientId: number; motivo: string }[]) => ({
  statusCode: 409,
  semogRefusal: destinatarios ? { codigo, destinatarios } : { codigo },
});
describe('Semog deadline extension refusal details', () => {
  it('names every ineligible recipient with a stable reason, in one answer', async () => {
    const fixture = createSemogExtensionFixture();
    fixture.envelope.recipients.push({ ...fixture.envelope.recipients[0], id: 15, token: 'token-15' });
    Object.assign(fixture.envelope.recipients[5], { expiresAt: null });
    await expect(
      fixture.service.create(fixture.actor, 'env', { ...body, recipientIds: [10, 11, 12, 13, 15, 99] }),
    ).rejects.toMatchObject(
      refusal('destinatarios-inelegiveis', [
        { recipientId: 11, motivo: 'ja-assinou' },
        { recipientId: 12, motivo: 'nao-signatario' },
        { recipientId: 13, motivo: 'operacao-existente' },
        { recipientId: 15, motivo: 'sem-prazo' },
        { recipientId: 99, motivo: 'nao-encontrado' },
      ]),
    );
    expect(fixture.tx.recipient.updateMany).not.toHaveBeenCalled();
  });
  it('refuses a CC even with a non-null expiresAt: the role check fires', async () => {
    const fixture = createSemogExtensionFixture();
    Object.assign(fixture.envelope.recipients[2], { expiresAt: '2097-01-01T00:00:00.000Z' });
    await expect(fixture.service.create(fixture.actor, 'env', { ...body, recipientIds: [12] })).rejects.toMatchObject(
      refusal('destinatarios-inelegiveis', [{ recipientId: 12, motivo: 'nao-signatario' }]),
    );
  });
  it('refuses a recipient without a deadline', async () => {
    const fixture = createSemogExtensionFixture();
    Object.assign(fixture.envelope.recipients[0], { expiresAt: null });
    await expect(fixture.service.create(fixture.actor, 'env', { ...body, recipientIds: [10] })).rejects.toMatchObject(
      refusal('destinatarios-inelegiveis', [{ recipientId: 10, motivo: 'sem-prazo' }]),
    );
  });
  it('refuses a deadline that does not move forward', async () => {
    const fixture = createSemogExtensionFixture();
    await expect(
      fixture.service.create(fixture.actor, 'env', { ...body, expiraEm: '2097-12-31T23:59:59.000-03:00' }),
    ).rejects.toMatchObject(
      refusal('destinatarios-inelegiveis', [
        { recipientId: 10, motivo: 'prazo-nao-avanca' },
        { recipientId: 14, motivo: 'prazo-nao-avanca' },
      ]),
    );
  });
  it('refuses an envelope with a REJECTED recipient', async () => {
    const fixture = createSemogExtensionFixture();
    Object.assign(fixture.envelope.recipients[3], { signingStatus: 'REJECTED' });
    await expect(fixture.service.create(fixture.actor, 'env', body)).rejects.toMatchObject(
      refusal('envelope-com-recusa'),
    );
  });
  it('refuses a non-PENDING envelope and a past deadline with their own codes', async () => {
    const closed = createSemogExtensionFixture();
    Object.assign(closed.envelope, { status: 'COMPLETED' });
    await expect(closed.service.create(closed.actor, 'env', body)).rejects.toMatchObject(
      refusal('envelope-nao-pendente'),
    );
    const past = createSemogExtensionFixture();
    for (const recipient of past.envelope.recipients) {
      Object.assign(recipient, { expiresAt: '2020-01-01T00:00:00.000Z' });
    }
    await expect(
      past.service.create(past.actor, 'env', { ...body, expiraEm: '2021-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject(refusal('prazo-no-passado'));
  });
  it('names the missing recipient whose live enrollment blocks the batch', async () => {
    const fixture = createSemogExtensionFixture();
    fixture.state.snapshots.push({
      id: 's-14',
      recipientId: 14,
      expiraEm: '2098-01-01T00:00:00.000Z',
      revogadaEm: null,
    });
    await expect(fixture.service.create(fixture.actor, 'env', { ...body, recipientIds: [10] })).rejects.toMatchObject(
      refusal('destinatarios-inelegiveis', [{ recipientId: 14, motivo: 'inscricao-vigente' }]),
    );
  });
  it('answers a reused key with another body, or a key taken by another envelope, as chave-reutilizada', async () => {
    const fixture = createSemogExtensionFixture();
    await fixture.service.create(fixture.actor, 'env', body);
    await expect(fixture.service.create(fixture.actor, 'env', { ...body, recipientIds: [10] })).rejects.toMatchObject(
      refusal('chave-reutilizada'),
    );
    const racing = createSemogExtensionFixture();
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
});

describe('Semog deadline extension HTTP boundary', () => {
  const url = 'https://local.invalid/api/semog/v1/envelopes/env/prorrogacoes';
  const post = (payload: string, headers: Record<string, string> = {}, target = url) =>
    new Request(target, {
      method: 'POST',
      headers: { authorization: 'Bearer api_0123456789abcdef', 'content-type': 'application/json', ...headers },
      body: payload,
    });
  const service = () => ({
    authenticate: vi.fn(async () => ({ teamId: 1, userId: 2 })),
    create: vi.fn(async () => ({
      chaveOperacao: SEMOG_EXTENSION_KEY,
      envelopeId: 'env',
      recipientIds: [10],
      expiraEm: SEMOG_NEW_EXPIRY,
      snapshotsRevogados: 0,
    })),
  });
  it('requires bearer, JSON, a bounded body and a well-formed path', async () => {
    const fake = service();
    const handler = createSemogExtensionHandler(fake);
    expect((await handler(post(JSON.stringify(body), { authorization: '' }))).status).toBe(401);
    expect((await handler(post(JSON.stringify(body), { 'content-type': 'text/plain' }))).status).toBe(400);
    expect((await handler(post('{'))).status).toBe(400);
    expect((await handler(post('x'.repeat(8193)))).status).toBe(413);
    expect((await handler(new Request(url, { headers: { authorization: 'Bearer x' } }))).status).toBe(404);
    const malformed = 'https://local.invalid/api/semog/v1/envelopes/env%E0%A4%A/prorrogacoes';
    expect((await handler(post(JSON.stringify(body), {}, malformed))).status).toBe(400);
    expect(fake.create).not.toHaveBeenCalled();
    const accepted = await handler(post(JSON.stringify(body)));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(fake.create).toHaveBeenCalledWith({ teamId: 1, userId: 2 }, 'env', body);
  });
  it('returns the refusal code and recipients, nothing else', async () => {
    const fixture = createSemogExtensionFixture();
    const response = await createSemogExtensionHandler(fixture.service)(
      post(JSON.stringify({ ...body, recipientIds: [13, 10] })),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Solicitação não autorizada ou inválida.',
      codigo: 'destinatarios-inelegiveis',
      destinatarios: [{ recipientId: 13, motivo: 'operacao-existente' }],
    });
  });
  it('sanitizes native failures', async () => {
    const fake = service();
    fake.create.mockRejectedValueOnce(new Error('private database secret'));
    const failed = await createSemogExtensionHandler(fake)(post(JSON.stringify(body)));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private');
  });
});
