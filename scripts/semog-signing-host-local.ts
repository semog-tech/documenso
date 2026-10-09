import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { PrismaClient } from '@prisma/client';
import { Hono } from 'hono';
import { mountSemogSigningRoutes } from '../apps/remix/server/semog-signing-routes';
import { createSemogHost } from '../packages/lib/server-only/semog-signing/host';
import { createSemogHostRateLimit } from '../packages/lib/server-only/semog-signing/host-rate-limit';

// Explicit unreachable fixture database: these requests must never attempt a database connection.
const client = new PrismaClient({ datasources: { db: { url: 'postgresql://local-test-only@127.0.0.1:1/local' } } });
const errors: unknown[] = [];
let enabled = false;
const disabled = createSemogHost({ client, onError: (error) => errors.push(error) });
const active = createSemogHost({ client, enabled: true, onError: (error) => errors.push(error) });
const app = new Hono();
let rateChecks = 0;
let rateFailure = false;
const keys: string[] = [];
mountSemogSigningRoutes(app, {
  basePath: '',
  rateLimit: createSemogHostRateLimit({
    enabled: () => enabled,
    maximum: 1,
    authenticate: async () => null,
    consume: (key) => {
      if (rateFailure) {
        return Promise.reject(new Error('local rate counter failure'));
      }
      keys.push(key);
      rateChecks++;
      return Promise.resolve({ count: rateChecks, reset: new Date(Date.now() + 60000) });
    },
  }),
  handler: (request) => (enabled ? active : disabled).handler(request),
});
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
try {
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  const address = server.address();
  assert(address !== null && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/semog/v1/envelopes-rascunho`;
  assert.equal((await fetch(url, { method: 'POST', body: '{invalid' })).status, 404);
  enabled = true;
  const unauthorized = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer invalid' },
    body: '{invalid',
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('cache-control'), 'no-store');
  assert.equal(rateChecks, 1);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer another', 'X-Forwarded-For': '2.2.2.2' },
        body: '{invalid',
      })
    ).status,
    429,
  );
  assert.equal(keys[0], keys[1]);
  rateFailure = true;
  assert.equal((await fetch(url, { method: 'POST', body: '{invalid' })).status, 503);
  assert.equal(errors.length, 0);
  process.stdout.write(
    'Real loopback HTTP process: mounted Semog route, rate middleware, default-off and auth-before-body passed.\n',
  );
} finally {
  await disabled.stop();
  await active.stop();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await client.$disconnect();
}
