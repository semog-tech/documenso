import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const container = `semog-host-${randomUUID()}`;
const run = (args: string[], input = '') =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (bytes: Buffer) => {
      output += bytes.toString();
    });
    child.stderr.on('data', (bytes: Buffer) => {
      output += bytes.toString();
    });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(output));
      }
    });
    child.stdin.end(input);
  });
const sql = (input: string) =>
  run(['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'], input);
try {
  await run([
    'run',
    '-d',
    '--rm',
    '--network',
    'none',
    '--name',
    container,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:16-alpine',
  ]);
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    try {
      await sql('SELECT 1;');
      ready = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  assert(ready, 'Local PostgreSQL did not start');
  const up = await readFile('db/2026-10-07-semog-host.sql', 'utf8'),
    down = await readFile('db/2026-10-07-semog-host.down.sql', 'utf8');
  await sql(`CREATE ROLE semog_bridge_service; CREATE ROLE host_intruder; CREATE SCHEMA semog_bridge;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO host_intruder;
    CREATE TABLE semog_bridge.outbox(id text PRIMARY KEY,"chaveOperacao" uuid,"envelopeId" text,kind text,payload jsonb,
      estado text DEFAULT 'pendente',tentativa int DEFAULT 0,lease uuid,"leaseAte" timestamptz,"criadaEm" timestamptz DEFAULT clock_timestamp());`);
  await sql(up);
  await sql(down);
  await sql(up);
  const operation = randomUUID();
  await sql(`INSERT INTO semog_bridge.outbox(id,"chaveOperacao","envelopeId",kind,payload) VALUES
    ('email','${operation}','local','job','{}'),('seal-a','${operation}','local','seal','{}'),('seal-b','${operation}','local','seal','{}');`);
  await assert.rejects(
    sql('SET ROLE host_intruder; SELECT public.semog_signing_claim_seal_effect(120);'),
    /permission denied/,
  );
  assert.equal(
    await sql(
      "SELECT has_function_privilege('host_intruder','public.semog_signing_claim_seal_effect(integer)','EXECUTE');",
    ),
    'f',
  );
  const claim = 'SET ROLE semog_bridge_service; SELECT public.semog_signing_claim_seal_effect(120);';
  const [first, second] = await Promise.all([sql(claim), sql(claim)]);
  assert.notEqual(JSON.parse(first).id, JSON.parse(second).id);
  assert.equal(JSON.parse(first).tentativa, 1);
  assert.equal(await sql("SELECT estado FROM semog_bridge.outbox WHERE id='email';"), 'pendente');
  assert.equal(await sql(`${claim.slice(0, -1)} IS NULL;`), 't');
  await sql(
    `UPDATE semog_bridge.outbox SET "leaseAte"=clock_timestamp()-interval '1 second' WHERE id='${JSON.parse(first).id}';`,
  );
  const retry = JSON.parse(await sql(claim));
  assert.equal(retry.id, JSON.parse(first).id);
  assert.equal(retry.tentativa, 2);
  assert.notEqual(retry.lease, JSON.parse(first).lease);
  await assert.rejects(sql(down), /reconcile pending seals/);
  await sql("UPDATE semog_bridge.outbox SET estado='delivered' WHERE kind='seal';");
  await sql(down);
  process.stdout.write(
    'Host PostgreSQL: seal-only concurrent claims, durable lease retry, external effects preserved, effective ACL and rollback guards passed.\n',
  );
} finally {
  await run(['rm', '--force', container]);
}
