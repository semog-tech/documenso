import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { jobs } from '../../jobs/client';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';
import { createSemogCancelHandler } from './cancel-http';
import { createSemogCancelService } from './cancel-service';
import { createSemogCancelFixture, SEMOG_CANCEL_KEY } from './cancel-test-fixtures';

// The native cancel queues the cancellation e-mails and the webhook; the bridge cancellation must do neither.
vi.mock('../../jobs/client', () => ({ jobs: { triggerJob: vi.fn() } }));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));

const body = { chaveOperacao: SEMOG_CANCEL_KEY, motivo: '  Assembleia remarcada.  ' };
const refusal = (codigo: string) => ({ statusCode: 409, semogRefusal: { codigo } });

describe('Semog envelope cancellation', () => {
  it('cancels the envelope, writes DOCUMENT_CANCELLED and revokes every live enrollment', async () => {
    const fixture = createSemogCancelFixture();
    const result = await fixture.service.create(fixture.actor, 'env', body);
    expect(result).toEqual({
      chaveOperacao: SEMOG_CANCEL_KEY,
      envelopeId: 'env',
      situacao: 'cancelado',
      canceladoEm: fixture.state.envelope.completedAt?.toISOString(),
      revogados: 3,
    });
    expect(fixture.state.envelope.status).toBe('CANCELLED');
    expect(fixture.state.snapshots.every((s) => s.revogadaEm !== null)).toBe(true);
    expect(fixture.state.receipts).toMatchObject([{ chaveOperacao: SEMOG_CANCEL_KEY, resultado: result }]);
    expect(fixture.state.audits).toMatchObject([
      { data: { type: 'DOCUMENT_CANCELLED', envelopeId: 'env', userId: 2, data: { reason: 'Assembleia remarcada.' } } },
    ]);
    expect(fixture.tx.envelope.updateMany).toHaveBeenCalledWith({
      where: { id: 'env', teamId: 1, status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: expect.any(Date) },
    });
    expect(fixture.transactions[0]).toMatchObject({ isolationLevel: 'ReadCommitted' });
    expect(fixture.state.jobs).toHaveLength(0);
    expect(vi.mocked(jobs.triggerJob)).not.toHaveBeenCalled();
    expect(vi.mocked(triggerWebhook)).not.toHaveBeenCalled();
  });

  it('cancels with nothing live to revoke', async () => {
    const fixture = createSemogCancelFixture();
    fixture.state.snapshots.length = 0;
    expect((await fixture.service.create(fixture.actor, 'env', body)).revogados).toBe(0);
  });

  it('replays the same key and reason with the stored result, even after the envelope is cancelled', async () => {
    const fixture = createSemogCancelFixture();
    const first = await fixture.service.create(fixture.actor, 'env', body);
    const again = await fixture.service.create(fixture.actor, 'env', { ...body, motivo: 'Assembleia remarcada.' });
    expect(again).toEqual(first);
    expect(fixture.tx.envelope.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.state.audits).toHaveLength(1);
  });

  it('refuses a reused key with another reason or envelope, and a key taken concurrently elsewhere', async () => {
    const fixture = createSemogCancelFixture();
    await fixture.service.create(fixture.actor, 'env', body);
    await expect(fixture.service.create(fixture.actor, 'env', { ...body, motivo: 'Outro' })).rejects.toMatchObject(
      refusal('chave-reutilizada'),
    );
    fixture.state.receipts[0].envelopeId = 'outro';
    await expect(fixture.service.create(fixture.actor, 'env', body)).rejects.toMatchObject(
      refusal('chave-reutilizada'),
    );
    const racing = createSemogCancelFixture();
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
    change: (fixture: ReturnType<typeof createSemogCancelFixture>) => void,
    expected: Record<string, unknown>,
    actor = { teamId: 1, userId: 2 },
  ) => {
    const fixture = createSemogCancelFixture();
    change(fixture);
    await expect(fixture.service.create(actor, 'env', body)).rejects.toMatchObject(expected);
    expect(fixture.tx.envelope.updateMany).not.toHaveBeenCalled();
    expect(fixture.state.receipts).toHaveLength(0);
    expect(fixture.state.snapshots.every((s) => s.revogadaEm === null)).toBe(true);
    expect(fixture.state.audits).toHaveLength(0);
  };
  it('refuses an envelope that is not PENDING', async () => {
    for (const status of ['CANCELLED', 'COMPLETED', 'REJECTED', 'DRAFT']) {
      await refuse((fixture) => Object.assign(fixture.state.envelope, { status }), refusal('envelope-nao-pendente'));
    }
  });
  it('refuses a second key once the envelope is cancelled', async () => {
    const fixture = createSemogCancelFixture();
    await fixture.service.create(fixture.actor, 'env', body);
    await expect(
      fixture.service.create(fixture.actor, 'env', { ...body, chaveOperacao: '0b4f7a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b' }),
    ).rejects.toMatchObject(refusal('envelope-nao-pendente'));
    expect(fixture.state.receipts).toHaveLength(1);
  });
  it('refuses while a manifestation is in flight', async () => {
    await refuse(
      (fixture) => fixture.state.operations.push({ estado: 'pendente', snapshotLive: true }),
      refusal('operacao-em-andamento'),
    );
  });
  it('is not blocked by a pending operation that can never execute (its snapshot expired or was revoked)', async () => {
    const fixture = createSemogCancelFixture();
    fixture.state.operations.push({ estado: 'pendente', snapshotLive: false });
    const result = await fixture.service.create(fixture.actor, 'env', body);
    expect(result).toMatchObject({ situacao: 'cancelado', revogados: 3 });
    expect(fixture.state.envelope.status).toBe('CANCELLED');
  });
  it('refuses another team and an envelope the bridge did not activate without revealing it', async () => {
    await refuse(() => undefined, { statusCode: 404 }, { teamId: 7, userId: 2 });
    await refuse((fixture) => Object.assign(fixture.state, { managed: false }), { statusCode: 404 });
  });
  it('refuses malformed bodies before any transaction', async () => {
    const fixture = createSemogCancelFixture();
    for (const invalid of [
      {},
      { chaveOperacao: SEMOG_CANCEL_KEY },
      { ...body, motivo: '   ' },
      { ...body, motivo: 'x'.repeat(501) },
      { ...body, motivo: 7 },
      { ...body, chaveOperacao: 'x' },
      { ...body, extra: true },
    ]) {
      await expect(fixture.service.create(fixture.actor, 'env', invalid)).rejects.toThrow();
    }
    await expect(fixture.service.create(fixture.actor, '', body)).rejects.toThrow();
    expect(fixture.transactions).toHaveLength(0);
    // The upper bound itself is accepted.
    expect((await fixture.service.create(fixture.actor, 'env', { ...body, motivo: 'x'.repeat(500) })).revogados).toBe(
      3,
    );
  });
  it('answers 503 when disabled and 401 for an unknown token', async () => {
    const fixture = createSemogCancelFixture();
    const disabled = createSemogCancelService({ client: fixture.client, authenticate: fixture.authenticate });
    await expect(disabled.authenticate('valid')).rejects.toMatchObject({ statusCode: 503 });
    await expect(disabled.create(fixture.actor, 'env', body)).rejects.toMatchObject({ statusCode: 503 });
    await expect(fixture.service.authenticate('unknown')).rejects.toMatchObject({ statusCode: 401 });
    expect(await fixture.service.authenticate('valid')).toEqual(fixture.actor);
    expect(fixture.transactions).toHaveLength(0);
  });
});

describe('Semog envelope cancellation HTTP boundary', () => {
  const url = 'https://local.invalid/api/semog/v1/envelopes/env/cancelamento';
  const post = (payload: string, headers: Record<string, string> = {}, target = url) =>
    new Request(target, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json', ...headers },
      body: payload,
    });
  it('requires bearer, JSON, a bounded body and a well-formed path', async () => {
    const fake = {
      authenticate: vi.fn(async () => ({ teamId: 1, userId: 2 })),
      create: vi.fn(async () => ({
        chaveOperacao: SEMOG_CANCEL_KEY,
        envelopeId: 'env',
        situacao: 'cancelado' as const,
        canceladoEm: '2026-10-30T12:00:00.000Z',
        revogados: 3,
      })),
    };
    const handler = createSemogCancelHandler(fake);
    expect((await handler(post(JSON.stringify(body), { authorization: '' }))).status).toBe(401);
    expect((await handler(post(JSON.stringify(body), { 'content-type': 'text/plain' }))).status).toBe(400);
    expect((await handler(post('x'.repeat(4097)))).status).toBe(413);
    expect((await handler(new Request(url, { headers: { authorization: 'Bearer x' } }))).status).toBe(404);
    expect((await handler(post(JSON.stringify(body), {}, `${url}/extra`))).status).toBe(404);
    const malformed = 'https://local.invalid/api/semog/v1/envelopes/env%E0%A4%A/cancelamento';
    expect((await handler(post(JSON.stringify(body), {}, malformed))).status).toBe(400);
    expect(fake.create).not.toHaveBeenCalled();
    const accepted = await handler(post(JSON.stringify(body)));
    expect(accepted.status).toBe(200);
    expect(fake.create).toHaveBeenCalledWith({ teamId: 1, userId: 2 }, 'env', body);
  });
  it('answers the real service: 200 result, 400 bad body, 401, 404 and coded 409s', async () => {
    const fixture = createSemogCancelFixture();
    const handler = createSemogCancelHandler(fixture.service);
    expect((await handler(post(JSON.stringify({ ...body, motivo: '' })))).status).toBe(400);
    expect((await handler(post(JSON.stringify(body), { authorization: 'Bearer unknown' }))).status).toBe(401);
    expect((await handler(post(JSON.stringify(body), {}, url.replace('/env/', '/outro/')))).status).toBe(404);
    fixture.state.operations.push({ estado: 'pendente', snapshotLive: true });
    const inFlight = await handler(post(JSON.stringify(body)));
    expect(inFlight.status).toBe(409);
    expect(await inFlight.json()).toEqual({
      error: 'Solicitação não autorizada ou inválida.',
      codigo: 'operacao-em-andamento',
    });
    fixture.state.operations.length = 0;
    const accepted = await handler(post(JSON.stringify(body)));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ situacao: 'cancelado', revogados: 3 });
    const notPending = await handler(
      post(JSON.stringify({ ...body, chaveOperacao: '0b4f7a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b' })),
    );
    expect(notPending.status).toBe(409);
    expect(await notPending.json()).toMatchObject({ codigo: 'envelope-nao-pendente' });
    const reused = await handler(post(JSON.stringify({ ...body, motivo: 'Outro' })));
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ codigo: 'chave-reutilizada' });
  });
});
