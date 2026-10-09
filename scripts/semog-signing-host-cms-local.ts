/** Reuses the unchanged native schema/PDF/certificate fixture in a disposable generated script. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const workspace = process.cwd();
const originalPath = resolve('scripts/semog-signing-execution-local.ts');
const original = await readFile(originalPath);
const source = original.toString('utf8').replaceAll('\r\n', '\n');
const marker = (text: string) => {
  const index = source.indexOf(text);
  assert(index >= 0 && source.indexOf(text, index + text.length) < 0, `Bootstrap marker missing or ambiguous: ${text}`);
  return index;
};
const setupEnd = marker("  const signed = await createFixture(1001, 'assinar');");
const certificateStart = marker("  await openssl([\n    'req',");
const certificateEnd = marker('  const sealer = createSemogPrismaSealer({');
const cleanup = marker('} finally {\n  await client?.$disconnect();');
const imports = `import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mountSemogSigningRoutes } from '../apps/remix/server/semog-signing-routes';
import { createSemogHost } from '../packages/lib/server-only/semog-signing/host';
import { createSemogHostRateLimit } from '../packages/lib/server-only/semog-signing/host-rate-limit';
import { createSemogApiTokenAuthenticator } from '../packages/lib/server-only/semog-signing/api-token';
import { ZSemogExecutionResult } from '../packages/lib/server-only/semog-signing/execution-contract';
`;
const scenario = `
  await sql(await readFile('db/2026-10-07-semog-host.sql', 'utf8'));
  const autonomous = await createFixture(2001, 'assinar');
  const token = 'api_' + randomUUID().replaceAll('-', '').slice(0, 16);
  await database.apiToken.create({ data: { name: 'Host disposable test', token: createHash('sha512').update(token).digest('hex'), userId: user.id, teamId: team.id } });
  const workerErrors: unknown[] = [];
  const host = createSemogHost({ enabled: true, client: database, signer, getDocumentI18n, intervalMs: 50,
    rejectionFont: await readFile('apps/remix/public/fonts/noto-sans.ttf'), onError: (error) => workerErrors.push(error) });
  const app = new Hono();
  const keys: string[] = [];
  mountSemogSigningRoutes(app, { basePath: '', handler: (request) => host.handler(request),
    rateLimit: createSemogHostRateLimit({ enabled: () => true, authenticate: createSemogApiTokenAuthenticator(database), consume: async (key) => {
      keys.push(key);
      const bucket = new Date(Date.now() - Date.now() % 60000);
      const counter = await database.rateLimit.upsert({ where: { key_action_bucket: { key, action: 'host-cms-local', bucket } },
        create: { key, action: 'host-cms-local', bucket, count: 1 }, update: { count: { increment: 1 } } });
      return { count: counter.count, reset: new Date(bucket.getTime() + 60000) };
    } }) });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  try {
    if (!server.listening) { await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); }); }
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('Local HTTP address absent'); }
    const origin = 'http://127.0.0.1:' + address.port;
    const authenticated = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const posted = await fetch(origin + '/api/semog/v1/manifestacoes', { method: 'POST', headers: authenticated, body: JSON.stringify(autonomous.input) });
    assert(posted.status === 200, 'Bridge HTTP manifestation failed: ' + posted.status + ' ' + await posted.clone().text());
    const receipt = ZSemogExecutionResult.parse(await posted.json());
    assert(receipt.situacao === 'concluida' && !receipt.pdfDisponivel && !receipt.documentoConcluido, 'HTTP falsely confirmed PDF before sealing');
    assert((await database.recipient.count({ where: { envelopeId: autonomous.envelopeId, signingStatus: { not: 'SIGNED' } } })) === 0, 'Not all native recipients are SIGNED');
    const endpoint = origin + '/api/semog/v1/manifestacoes/' + autonomous.input.chaveOperacao;
    assert((await fetch(endpoint + '/pdf', { headers: authenticated })).status === 409, 'PDF available before autonomous worker');
    assert((await database.envelope.findUniqueOrThrow({ where: { id: autonomous.envelopeId } })).status === 'PENDING', 'Native completion happened without host worker');
    process.chdir(resolve(workspace, 'apps/remix'));
    host.start();
    for (let attempt = 0; attempt < 300; attempt++) {
      const response = await fetch(endpoint, { headers: authenticated });
      assert(response.status === 200 || response.status === 503, 'Unexpected poll response: ' + response.status + ' ' + await response.clone().text());
      if (response.status === 200) {
        const state = ZSemogExecutionResult.parse(await response.json());
        if (state.pdfDisponivel) { break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await host.stop();
    process.chdir(workspace);
    assert(workerErrors.length === 0, 'Autonomous worker failed: ' + workerErrors.map(String).join(';'));
    const download = await fetch(endpoint + '/pdf', { headers: authenticated });
    assert(download.status === 200 && download.headers.get('content-type') === 'application/pdf', 'Authenticated autonomous PDF download failed');
    const downloaded = new Uint8Array(await download.arrayBuffer());
    assert(download.headers.get('x-documento-sha256') === createHash('sha256').update(downloaded).digest('hex'), 'Downloaded PDF hash mismatch');
    await validateCms(downloaded);
    assert((await PDF.load(downloaded)).getPageCount() >= 3, 'Native certificate/audit appendix missing');
    assert((await database.field.findUniqueOrThrow({ where: { id: autonomous.observation.id } })).customText === autonomous.input.campos[1].valor, 'Opinion observation changed');
    assert((await database.documentAuditLog.count({ where: { envelopeId: autonomous.envelopeId, type: 'DOCUMENT_COMPLETED' } })) === 1, 'Completion audit absent or duplicated');
    assert((await sql("SELECT count(*) FROM semog_bridge.outbox WHERE kind='seal' AND estado='delivered'")).trim() === '1', 'Autonomous seal was not acknowledged');
    assert((await sql("SELECT count(*) FROM semog_bridge.outbox WHERE kind<>'seal' AND estado<>'pendente'")).trim() === '0', 'Suppressed outbound effects were falsely acknowledged');
    assert((await fetch(endpoint + '/pdf')).status === 401, 'Unauthenticated PDF download allowed');
    assert(keys.filter((key) => key.startsWith('semog:token:')).length > 0 && !keys.some((key) => key.includes(token)), 'Token rate counter binding absent or leaked');
    console.log('AUTONOMOUS CMS PASSED: actual loopback bridge HTTP, all native recipients SIGNED, createSemogHost.start() alone sealed, authenticated PDF CMS verified by OpenSSL, native appendices/observation/audit preserved, seal ack only, no outbound delivery.');
  } finally {
    await host.stop();
    process.chdir(workspace);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
`;
const generated = resolve('scripts', `.semog-host-cms-${randomUUID()}.ts`);
assert(generated.startsWith(`${resolve(workspace, 'scripts')}${sep}`), 'Generated fixture outside script directory');
const body =
  imports +
  source.slice(0, setupEnd) +
  source.slice(certificateStart, certificateEnd) +
  scenario +
  source.slice(cleanup);
assert(!/\.sealer\.seal\(|\bsealer\.seal\(/.test(body), 'Fixture must never invoke a manual seal');
try {
  await writeFile(generated, body);
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [resolve('node_modules/vite-node/vite-node.mjs'), '--config', 'packages/lib/vitest.config.ts', generated],
      { cwd: workspace, stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        done();
      } else {
        reject(new Error(`Host CMS process exited with ${code}`));
      }
    });
  });
} finally {
  await unlink(generated);
  assert.equal(
    createHash('sha256')
      .update(await readFile(originalPath))
      .digest('hex'),
    createHash('sha256').update(original).digest('hex'),
    'Original native diagnostic was modified',
  );
}
