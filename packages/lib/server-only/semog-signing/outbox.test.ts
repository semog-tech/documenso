import { describe, expect, it, vi } from 'vitest';
import { createSemogNativeEffectDeliverer, createSemogOutboxWorker } from './outbox';

const effect = {
  id: 'durable-effect',
  chaveOperacao: '11111111-1111-4111-8111-111111111111',
  envelopeId: 'envelope',
  kind: 'webhook',
  payload: { event: 'DOCUMENT_COMPLETED', envelopeId: 'envelope' },
  lease: '22222222-2222-4222-8222-222222222222',
  estado: 'leased',
  tentativa: 1,
};
describe('durable outbox', () => {
  it('does not lease work without an explicit delivery adapter', async () => {
    const query = vi.fn();
    await expect(createSemogOutboxWorker({ enabled: true, client: { $queryRaw: query } }).tick()).rejects.toMatchObject(
      { statusCode: 503 },
    );
    expect(query).not.toHaveBeenCalled();
  });
  it('returns failure explicitly and acknowledges failure for retry, never delivery', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ body: effect }])
      .mockResolvedValueOnce([{ result: true }]);
    const deliver = vi.fn(() => Promise.reject(new Error('temporary provider failure')));
    const result = await createSemogOutboxWorker({ enabled: true, client: { $queryRaw: query }, deliver }).tick();
    expect(result).toEqual({ delivered: false, empty: false });
    expect(query.mock.calls[1][0].values.at(-1)).toBe(false);
  });
  it('rejects cross-envelope or malformed native effects and passes durable IDs', async () => {
    const native = { triggerJob: vi.fn(async () => {}), triggerWebhook: vi.fn(async () => {}) };
    const deliver = createSemogNativeEffectDeliverer(native);
    const parsed = { ...effect, kind: 'webhook' as const, estado: 'leased' as const };
    await deliver(parsed);
    expect(native.triggerWebhook).toHaveBeenCalledWith({
      idempotencyKey: effect.id,
      event: 'DOCUMENT_COMPLETED',
      envelopeId: 'envelope',
    });
    expect(() => deliver({ ...parsed, payload: { event: 'DOCUMENT_COMPLETED', envelopeId: 'other' } })).toThrow();
    expect(() =>
      deliver({
        ...parsed,
        kind: 'job',
        payload: { name: 'send.recipient.signed.email', payload: { documentId: 'invalid', recipientId: 1 } },
      }),
    ).toThrow();
  });
});
