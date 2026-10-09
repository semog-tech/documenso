import { describe, expect, it, vi } from 'vitest';
import type { SemogDraftResult } from './draft-contract';
import { semogDraftBodyLimit } from './draft-contract';
import { createSemogDraftHandler, SEMOG_DRAFT_PATH } from './draft-http';

const fixture = () => {
  const result: SemogDraftResult = {
    operacaoId: '13e678a2-c5c2-46d4-a565-e04760dcd712',
    envelopeId: 'envelope_local',
    status: 'DRAFT',
    documento: { itemId: 'item_local', sha256: 'a'.repeat(64) },
    signatarios: [],
  };
  const service = {
    maximumPdfBytes: 20,
    authenticate: vi.fn(async () => ({ teamId: 1, userId: 1 })),
    create: vi.fn(async () => result),
  };
  return { service, handler: createSemogDraftHandler(service) };
};
const request = (body: string, headers: Record<string, string> = {}) =>
  new Request(`https://bridge.invalid${SEMOG_DRAFT_PATH}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json', ...headers },
    body,
  });
describe('Semog draft HTTP adapter', () => {
  it('authenticates before malformed JSON and exposes no tokens/URLs', async () => {
    const { handler, service } = fixture();
    expect((await handler(request('{', { authorization: '' }))).status).toBe(401);
    expect(service.authenticate).not.toHaveBeenCalled();
    const result = await handler(request('{}'));
    expect(await result.json()).toEqual(await service.create());
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
  it('caps streaming body without Content-Length and before service/create', async () => {
    const { handler, service } = fixture();
    expect((await handler(request(JSON.stringify({ excess: 'x'.repeat(semogDraftBodyLimit(20)) })))).status).toBe(413);
    expect(service.create).not.toHaveBeenCalled();
    expect((await handler(request('{}', { 'content-length': '-1' }))).status).toBe(413);
  });
  it('rejects unknown routes, wrong type and sanitizes upstream failures', async () => {
    const { handler, service } = fixture();
    expect((await handler(new Request('https://bridge.invalid/api/v2/envelope/create'))).status).toBe(404);
    expect((await handler(request('{}', { 'content-type': 'text/plain' }))).status).toBe(400);
    service.create.mockRejectedValueOnce(new Error('private credential'));
    const result = await handler(request('{}'));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('private');
  });
});
