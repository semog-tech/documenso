import { type Context, Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createSemogHostRateLimit } from './host-rate-limit';

describe('Semog private host rate limit', () => {
  it('rotating forwarded IP headers cannot reset a token counter', async () => {
    const keys: string[] = [];
    const app = new Hono();
    app.use(
      '*',
      createSemogHostRateLimit({
        enabled: () => true,
        maximum: 1,
        authenticate: async () => ({ teamId: 1, userId: 1 }),
        consume: (key) => {
          keys.push(key);
          return Promise.resolve({ count: keys.length, reset: new Date(Date.now() + 60000) });
        },
      }),
    );
    app.post('/', (c) => c.text('ok'));
    const headers = { Authorization: 'Bearer api_1234567890123456', 'X-Forwarded-For': '1.1.1.1' };
    expect((await app.request('/', { method: 'POST', headers })).status).toBe(200);
    expect(
      (
        await app.request('/', {
          method: 'POST',
          headers: { ...headers, 'X-Forwarded-For': '2.2.2.2', 'X-Real-IP': '3.3.3.3' },
        })
      ).status,
    ).toBe(429);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toContain('1234567890123456');
  });
  it('invalid rotating credentials share a bounded unauthorized bucket', async () => {
    const consume = vi.fn((_key: string) => Promise.resolve({ count: 1, reset: new Date() }));
    const app = new Hono();
    app.use('*', createSemogHostRateLimit({ enabled: () => true, authenticate: async () => null, consume }));
    app.post('/', (c) => c.text('unauthorized', 401));
    for (const token of ['api_1234567890123456', 'api_abcdefghijklmnop']) {
      await app.request('/', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    }
    expect(consume.mock.calls.every((call) => call[0] === 'semog:unauthorized')).toBe(true);
  });
  it('DB failure prevents route execution rather than permitting requests', async () => {
    const handler = vi.fn((c: Context) => c.text('ok'));
    const app = new Hono();
    app.use(
      '*',
      createSemogHostRateLimit({
        enabled: () => true,
        authenticate: async () => null,
        consume: () => Promise.reject(new Error('local failure')),
      }),
    );
    app.post('/', handler);
    expect((await app.request('/', { method: 'POST' })).status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});
