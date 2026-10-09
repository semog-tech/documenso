import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const container = `semog-bridge-${randomUUID()}`;
const run = (args: string[], input = '', allowFailure = false): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure) {
        reject(new Error(output));
      } else {
        resolve(output);
      }
    });
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
const sql = (input: string, allowFailure = false) =>
  run(['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], input, allowFailure);
const snapshotId = 'ef1adad2-fde2-45f0-9154-5c3acd24702a';
const key = '4b849126-9a27-4a4c-96f4-e9741edb9acf';
const snapshot = {
  id: snapshotId,
  teamId: 1,
  envelopeId: 'e1',
  recipientId: 1,
  hashDocumento: 'a'.repeat(64),
  hashConsentimento: 'b'.repeat(64),
  hashSnapshot: 'c'.repeat(64),
  expiraEm: '2030-01-01T00:00:00Z',
  conteudo: { declaration: 'I agree' },
};
const operation = {
  chaveOperacao: key,
  snapshotId,
  teamId: 1,
  envelopeId: 'e1',
  recipientId: 1,
  hashDocumento: snapshot.hashDocumento,
  hashConsentimento: snapshot.hashConsentimento,
  acao: 'assinar',
  hashPedido: 'd'.repeat(64),
  pedido: { consent: true },
  evidencias: { verified: true },
};
const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const reserve = (value: typeof operation) =>
  `SET ROLE semog_bridge_service; SELECT public.semog_signing_reserve_operation(${literal(value)});`;
const expectFailure = async (statement: string) => {
  const result = await sql(statement, true);
  if (!result.includes('ERROR:')) {
    throw new Error(`Expected SQL rejection: ${statement}`);
  }
};
const testBoundaries = async () => {
  await expectFailure('SET ROLE semog_bridge_service; SELECT * FROM semog_bridge.snapshots;');
  await expectFailure('SET ROLE semog_bridge_service; DELETE FROM semog_bridge.operations;');
  await expectFailure(`SELECT public.semog_signing_register_snapshot(${literal({ ...snapshot, teamId: 2 })});`);
  await expectFailure(`SELECT public.semog_signing_register_snapshot(${literal({ ...snapshot, recipientId: 2 })});`);
  await expectFailure(reserve({ ...operation, hashDocumento: 'e'.repeat(64) }));
  const acl = await sql(
    "SELECT has_function_privilege('semog_untrusted','public.semog_signing_reserve_operation(jsonb)','EXECUTE');",
  );
  if (acl.trim() !== 'f') {
    throw new Error('PUBLIC function execution exposed');
  }
};
const testConcurrency = async () => {
  const first = sql(`BEGIN; ${reserve(operation)} SELECT pg_sleep(0.8); COMMIT;`);
  const second = sql(reserve(operation));
  await Promise.all([first, second]);
  const count = await sql('SELECT count(*) FROM semog_bridge.operations;');
  if (count.trim() !== '1') {
    throw new Error('Concurrent duplicate persisted twice');
  }
  await expectFailure(reserve({ ...operation, acao: 'recusar' }));
  await expectFailure(reserve({ ...operation, chaveOperacao: randomUUID() }));
  await expectFailure(reserve({ ...operation, teamId: 2 }));
};
const testRevocation = async () => {
  await sql(`SET ROLE semog_bridge_service; SELECT public.semog_signing_revoke_snapshot(1,'${snapshotId}');`);
  await sql(reserve(operation));
  await expectFailure(reserve({ ...operation, chaveOperacao: randomUUID() }));
  const hidden = await sql(
    `SET ROLE semog_bridge_service; SELECT public.semog_signing_get_operation(2,'${key}') IS NULL;`,
  );
  if (!hidden.trim().endsWith('t')) {
    throw new Error('Another team could read an operation');
  }
  const replacement = { ...snapshot, id: randomUUID() };
  await sql(`SET ROLE semog_bridge_service; SELECT public.semog_signing_register_snapshot(${literal(replacement)});`);
  await expectFailure(reserve({ ...operation, chaveOperacao: randomUUID(), snapshotId: replacement.id }));
};
const testOpposingConcurrency = async () => {
  const current = { ...snapshot, id: randomUUID(), envelopeId: 'e3', recipientId: 3 };
  await sql(`SELECT public.semog_signing_register_snapshot(${literal(current)});`);
  const signing = {
    ...operation,
    snapshotId: current.id,
    envelopeId: 'e3',
    recipientId: 3,
    chaveOperacao: randomUUID(),
  };
  const refusal = { ...signing, chaveOperacao: randomUUID(), acao: 'recusar' };
  const outcomes = await Promise.allSettled([sql(reserve(signing)), sql(reserve(refusal))]);
  if (outcomes.filter((result) => result.status === 'fulfilled').length !== 1) {
    throw new Error('Opposing concurrent actions did not elect exactly one intent');
  }
};
const testInactiveSnapshot = async () => {
  const current = { ...snapshot, id: randomUUID(), envelopeId: 'e4', recipientId: 4 };
  await sql(`SELECT public.semog_signing_register_snapshot(${literal(current)});`);
  const request = {
    ...operation,
    snapshotId: current.id,
    envelopeId: 'e4',
    recipientId: 4,
    chaveOperacao: randomUUID(),
  };
  await sql(`UPDATE semog_bridge.snapshots SET "expiraEm" = '2000-01-01' WHERE id = '${current.id}';`);
  await expectFailure(reserve(request));
  await sql(
    `UPDATE semog_bridge.snapshots SET "expiraEm" = '2030-01-01' WHERE id = '${current.id}'; SELECT public.semog_signing_revoke_snapshot(1,'${current.id}');`,
  );
  await expectFailure(reserve(request));
};
const main = async () => {
  const up = await readFile(new URL('../db/2026-10-06-semog-signing.sql', import.meta.url), 'utf8');
  const down = await readFile(new URL('../db/2026-10-06-semog-signing.down.sql', import.meta.url), 'utf8');
  await run([
    'run',
    '-d',
    '--name',
    container,
    '--network',
    'none',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:16-alpine',
  ]);
  try {
    // Initialization uses a temporary Unix-only server; require the final TCP server and an authenticated query.
    await run([
      'exec',
      container,
      'sh',
      '-c',
      'attempt=0; until pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -At -c "SELECT 1" >/dev/null 2>&1; do attempt=$((attempt + 1)); if [ "$attempt" -ge 100 ]; then echo "PostgreSQL readiness timeout" >&2; exit 1; fi; sleep 0.2; done',
    ]);
    // Minimal fixtures verify the actual FK names/types; they do not reproduce the complete engine catalog.
    await sql(
      'CREATE ROLE semog_bridge_service; CREATE ROLE semog_untrusted; CREATE TABLE public."Envelope"(id text PRIMARY KEY,"teamId" integer NOT NULL); CREATE TABLE public."Recipient"(id integer PRIMARY KEY,"envelopeId" text REFERENCES public."Envelope"(id)); INSERT INTO public."Envelope" VALUES(\'e1\',1),(\'e2\',2); INSERT INTO public."Recipient" VALUES(1,\'e1\'),(2,\'e2\');',
    );
    await sql(up);
    await sql(
      "INSERT INTO public.\"Envelope\" VALUES('e3',1),('e4',1); INSERT INTO public.\"Recipient\" VALUES(3,'e3'),(4,'e4');",
    );
    await sql(`SET ROLE semog_bridge_service; SELECT public.semog_signing_register_snapshot(${literal(snapshot)});`);
    await testBoundaries();
    await testConcurrency();
    await testRevocation();
    await testOpposingConcurrency();
    await testInactiveSnapshot();
    await sql(down);
    await sql(up);
    await sql(down);
    process.stdout.write(
      'Local PostgreSQL passed: ACL, tenant binding, concurrent replay, conflicts, revocation and up/down/up/down. Minimal engine fixtures only.\n',
    );
  } finally {
    await run(['rm', '-f', container]);
  }
};
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Database smoke failed'}\n`);
  process.exitCode = 1;
});
