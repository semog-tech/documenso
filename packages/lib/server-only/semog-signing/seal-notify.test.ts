import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSemogSealNotifier, type SemogSealNotifyResult } from './seal-notify';
import type { SemogStageTiming } from './timing';

const notification = { envelopeId: 'envelope_local', completedAt: '2026-11-04T20:11:00.000Z' };
const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  // listen(0) on TCP returns AddressInfo.
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/notify`;
  return {
    url,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
    },
  };
};
const setup = (url: string, observe?: (timing: SemogStageTiming) => void) => {
  const results: SemogSealNotifyResult[] = [];
  let finish: (result: SemogSealNotifyResult) => void = () => undefined;
  const done = new Promise<SemogSealNotifyResult>((resolve) => {
    finish = resolve;
  });
  const notify = createSemogSealNotifier({
    env: (key) => (key === 'SEMOG_SELAGEM_AVISO_URL' ? url : 'local-test-token'),
    observe,
    onResult: (result) => {
      results.push(result);
      finish(result);
    },
  });
  return { notify, results, done };
};
afterEach(() => vi.restoreAllMocks());

describe('best effort seal completion hint', () => {
  it.each([
    {},
    { SEMOG_SELAGEM_AVISO_URL: 'http://127.0.0.1' },
    { SEMOG_SELAGEM_AVISO_TOKEN: 'local-test-token' },
  ])('does not create a notifier, fetch or timer unless both envs exist: %j', (values: Record<
    string,
    string | undefined
  >) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const timer = vi.spyOn(globalThis, 'setTimeout');
    expect(createSemogSealNotifier({ env: (key) => values[key], onResult: vi.fn() })).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
  });
  it('POSTs the exact contract with bearer and reports only safe fields, even if the observer throws', async () => {
    let received: unknown;
    const server = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received = {
          method: request.method,
          authorization: request.headers.authorization,
          type: request.headers['content-type'],
          body: JSON.parse(Buffer.concat(chunks).toString()),
        };
        response.writeHead(204).end();
      });
    });
    const timings: SemogStageTiming[] = [];
    const { notify, done } = setup(server.url, (timing) => {
      timings.push(timing);
      throw new Error('telemetry unavailable');
    });
    try {
      expect(notify?.(notification)).toBeUndefined();
      const result = await done;
      expect(received).toEqual({
        method: 'POST',
        authorization: 'Bearer local-test-token',
        type: 'application/json',
        body: notification,
      });
      expect(result).toEqual({ envelopeId: notification.envelopeId, status: 'delivered', ms: expect.any(Number) });
      expect(timings).toEqual([{ stage: 'seal.notify', ms: expect.any(Number), ok: true }]);
    } finally {
      await server.close();
    }
  });
  it.each([true, false])('retries a 5xx exactly once (second attempt succeeds: %s)', async (succeeds) => {
    let calls = 0;
    const server = await listen((_request, response) => {
      response.writeHead(++calls === 2 && succeeds ? 204 : 503).end();
    });
    const timings: SemogStageTiming[] = [];
    const { notify, done } = setup(server.url, (timing) => timings.push(timing));
    try {
      notify?.(notification);
      expect((await done).status).toBe(succeeds ? 'delivered' : 'http-503');
      expect(calls).toBe(2);
      expect(timings).toEqual([{ stage: 'seal.notify', ms: expect.any(Number), ok: succeeds }]);
    } finally {
      await server.close();
    }
  });
  it('retries a real network disconnect once', async () => {
    let calls = 0;
    const server = await listen((request, response) => {
      if (++calls === 1) {
        request.socket.destroy();
      } else {
        response.writeHead(204).end();
      }
    });
    const { notify, done } = setup(server.url);
    try {
      notify?.(notification);
      expect((await done).status).toBe('delivered');
      expect(calls).toBe(2);
    } finally {
      await server.close();
    }
  });
  it('aborts a silent HTTP peer after 1.5s per attempt, retries once, and releases its slot', async () => {
    const calls: number[] = [];
    const attemptDurations: number[] = [];
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
      const started = performance.now();
      options?.signal?.addEventListener('abort', () => attemptDurations.push(performance.now() - started), {
        once: true,
      });
      return nativeFetch(input, options);
    });
    const server = await listen((_request, response) => {
      calls.push(performance.now());
      if (calls.length > 2) {
        response.writeHead(204).end();
      }
    });
    const { notify, results, done } = setup(server.url);
    try {
      notify?.(notification);
      const result = await done;
      expect(result.status).toBe('timeout');
      expect(result.ms).toBeGreaterThanOrEqual(2900);
      expect(result.ms).toBeLessThan(6000);
      expect(calls).toHaveLength(2);
      expect(attemptDurations).toHaveLength(2);
      expect(attemptDurations.every((duration) => duration >= 1450)).toBe(true);
      notify?.(notification);
      await vi.waitFor(() => expect(results).toHaveLength(2));
      expect(results[1].status).toBe('delivered');
    } finally {
      await server.close();
    }
  }, 10000);
  it.each([400, 401, 429, 302, 307])('does not retry HTTP %s or follow a redirect with credentials', async (status) => {
    let redirected = 0;
    const target = await listen((_request, response) => {
      redirected++;
      response.writeHead(204).end();
    });
    let calls = 0;
    const server = await listen((_request, response) => {
      calls++;
      response.writeHead(status, { Location: target.url }).end();
    });
    const { notify, done } = setup(server.url);
    try {
      notify?.(notification);
      expect((await done).status).toBe(`http-${status}`);
      expect(calls).toBe(1);
      expect(redirected).toBe(0);
    } finally {
      await server.close();
      await target.close();
    }
  });
  it('limits concurrency to two, drops overflow without a queue and isolates logging errors', async () => {
    const responses: ServerResponse[] = [];
    const server = await listen((_request, response) => responses.push(response));
    const results: SemogSealNotifyResult[] = [];
    const notify = createSemogSealNotifier({
      env: (key) => (key === 'SEMOG_SELAGEM_AVISO_URL' ? server.url : 'local-test-token'),
      onResult: (result) => {
        results.push(result);
        throw new Error('logger unavailable');
      },
    });
    try {
      for (let index = 0; index < 20; index++) {
        notify?.({ ...notification, envelopeId: `envelope_${index}` });
      }
      await vi.waitFor(() => expect(responses).toHaveLength(2));
      expect(results).toHaveLength(18);
      expect(results.every((result) => result.status === 'skipped-busy')).toBe(true);
      for (const response of responses) {
        response.writeHead(204).end();
      }
      await vi.waitFor(() => expect(results).toHaveLength(20));
      expect(responses).toHaveLength(2);
      notify?.(notification);
      await vi.waitFor(() => expect(responses).toHaveLength(3));
      responses[2].writeHead(204).end();
      await vi.waitFor(() => expect(results).toHaveLength(21));
    } finally {
      await server.close();
    }
  });
});
