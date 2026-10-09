import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSemogHost } from './host';

const client = new PrismaClient({ datasources: { db: { url: 'postgresql://local-test-only@127.0.0.1:1/local' } } });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('mounted Semog host', () => {
  it('does not start or parse a request by default', async () => {
    const query = vi.spyOn(client, '$queryRaw');
    const host = createSemogHost({ client, onError: vi.fn() });
    host.start();
    expect(
      (
        await host.handler(
          new Request('http://localhost/api/semog/v1/manifestacoes', { method: 'POST', body: '{invalid' }),
        )
      ).status,
    ).toBe(404);
    await host.stop();
    expect(query).not.toHaveBeenCalled();
  });
  it('native API token authentication happens before body parsing', async () => {
    const query = vi.spyOn(client, '$queryRaw');
    const host = createSemogHost({ enabled: true, client, onError: vi.fn() });
    expect(
      (
        await host.handler(
          new Request('http://localhost/api/semog/v1/envelopes-rascunho', {
            method: 'POST',
            headers: { Authorization: 'Bearer invalid' },
            body: '{invalid',
          }),
        )
      ).status,
    ).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  it('polls seal-only queue autonomously without acknowledging suppressed email/webhooks', async () => {
    vi.useFakeTimers();
    const query = vi.spyOn(client, '$queryRaw').mockResolvedValue([{ body: null }]);
    const host = createSemogHost({ enabled: true, client, intervalMs: 50, onError: vi.fn() });
    host.start();
    host.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(query).toHaveBeenCalledTimes(4);
    for (const call of query.mock.calls) {
      expect(call[0]).toMatchObject({
        strings: expect.arrayContaining([expect.stringContaining('claim_seal_effect')]),
      });
    }
    await host.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(query).toHaveBeenCalledTimes(4);
  });
  it('reports worker database failure and keeps a controlled retry loop', async () => {
    vi.useFakeTimers();
    const query = vi.spyOn(client, '$queryRaw').mockRejectedValue(new Error('local injected failure'));
    const onError = vi.fn();
    const host = createSemogHost({ enabled: true, client, intervalMs: 50, onError });
    host.start();
    await vi.advanceTimersByTimeAsync(100);
    await host.stop();
    expect(query).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
  });
  it('fails closed if external delivery is enabled without an explicit adapter', () => {
    expect(() => createSemogHost({ enabled: true, client, deliveryEnabled: true, onError: vi.fn() })).toThrow();
  });
});
