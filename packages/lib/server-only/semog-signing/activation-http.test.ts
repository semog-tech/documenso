import { describe, expect, it, vi } from 'vitest';
import { hashSemogActivation, ZSemogActivationRequest } from './activation-contract';
import { createSemogActivationHandler, SEMOG_ACTIVATION_PATH } from './activation-http';
import { createSemogActivationService } from './activation-service';

const input = {
  operacaoId: '13e678a2-c5c2-46d4-a565-e04760dcd712',
  rascunhoOperacaoId: '03e678a2-c5c2-46d4-a565-e04760dcd712',
  envelopeId: 'envelope_local',
  externalId: '23e678a2-c5c2-46d4-a565-e04760dcd712',
  hashPdf: 'a'.repeat(64),
  expiraEm: '2099-01-01T23:59:59.999-03:00',
};
const request = (body: string, headers: Record<string, string> = {}) =>
  new Request(`https://local.invalid${SEMOG_ACTIVATION_PATH}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json', ...headers },
    body,
  });
describe('Semog activation boundary', () => {
  it('binds every activation input and rejects untrusted tenant identity', () => {
    const parsed = ZSemogActivationRequest.parse(input);
    expect(() => ZSemogActivationRequest.parse({ ...input, teamId: 2 })).toThrow();
    expect(() => ZSemogActivationRequest.parse({ ...input, expiraEm: 'tomorrow' })).toThrow();
    expect(hashSemogActivation(parsed)).not.toBe(hashSemogActivation({ ...parsed, hashPdf: 'b'.repeat(64) }));
  });
  it('is disabled before any transaction or authentication', async () => {
    const transaction = vi.fn();
    const authenticate = vi.fn();
    const service = createSemogActivationService({ client: { $transaction: transaction }, authenticate });
    await expect(service.activate({ teamId: 1, userId: 1 }, input)).rejects.toMatchObject({ statusCode: 503 });
    await expect(service.authenticate('test')).rejects.toMatchObject({ statusCode: 503 });
    expect(transaction).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('requires auth, caps body and sanitizes native failures without invoking activation', async () => {
    const activate = vi.fn().mockRejectedValue(new Error('private database secret'));
    const handler = createSemogActivationHandler({
      authenticate: vi.fn(async () => ({ teamId: 1, userId: 1 })),
      activate,
    });
    expect((await handler(request('{', { authorization: '' }))).status).toBe(401);
    expect((await handler(request('{'))).status).toBe(400);
    expect((await handler(request('{}', { 'content-type': 'text/plain' }))).status).toBe(400);
    expect((await handler(request('x'.repeat(65537)))).status).toBe(413);
    expect(activate).not.toHaveBeenCalled();
    const failed = await handler(request(JSON.stringify(input)));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private');
    expect(failed.headers.get('cache-control')).toBe('no-store');
  });
});
