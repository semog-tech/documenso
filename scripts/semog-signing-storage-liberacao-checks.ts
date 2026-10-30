/**
 * Local proof of db/2026-11-01-semog-storage-liberacao.sql on real PostgreSQL + MinIO, run by
 * scripts/semog-signing-storage-local.ts after its own sections: PENDING/CANCELLED eligibility, the cancelled-envelope
 * guard, the purge rules (retention, sharing, partial seal, idempotence, resume, grace), the CLI, the daily sweep,
 * the ACL and the down/up pair. Never touches a remote database or bucket.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { PrismaClient } from '@prisma/client';
import type { SemogPdfStore } from '../packages/lib/server-only/semog-signing/pdf-store';
import { putSemogStoredPdf, readSemogStoredPdf } from '../packages/lib/server-only/semog-signing/pdf-store';
import type { SemogS3Settings } from '../packages/lib/server-only/semog-signing/pdf-store-s3';
import { createSemogS3PurgeObjects } from '../packages/lib/server-only/semog-signing/pdf-store-s3';
import {
  migrateSemogStorageRow,
  planSemogStorageMigration,
} from '../packages/lib/server-only/semog-signing/storage-migration';
import type { SemogPurgeObjects } from '../packages/lib/server-only/semog-signing/storage-purge';
import { createSemogPurgeLedger, runSemogStoragePurge } from '../packages/lib/server-only/semog-signing/storage-purge';
import { sweepSemogCancelledStorage } from '../packages/lib/server-only/semog-signing/storage-purge-sweep';

type Document = { type: 'BYTES_64' | 'S3_PATH'; data: string };
type Fixture = { envelopeId: ReturnType<typeof randomUUID>; recipientId: number; fieldId: number };
export type SemogStorageLiberacaoDeps = {
  client: PrismaClient;
  actor: { teamId: number; userId: number };
  databaseUrl: string;
  settings: SemogS3Settings;
  store: SemogPdfStore;
  sql: (statement: string) => Promise<string>;
  migration: (name: string, direction?: 'up' | 'down') => Promise<string>;
  createEnvelope: (document: Document) => Promise<Fixture>;
  /** Enrolls the only recipient; with `seal`, also signs and seals (the envelope ends COMPLETED). */
  signAndSeal: (fixture: Fixture, seal: boolean) => Promise<unknown>;
  pdf: (label: string) => Promise<Uint8Array>;
};

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};
const rejects = async (fn: () => Promise<unknown>, pattern: RegExp, message: string) => {
  try {
    await fn();
  } catch (error) {
    assert(pattern.test(error instanceof Error ? error.message : String(error)), `${message}: ${String(error)}`);
    return;
  }
  throw new Error(`${message}: não recusou`);
};
const keyOf = (bytes: Uint8Array) => `semog/pdf/${createHash('sha256').update(bytes).digest('hex')}.pdf`;
const inline = (bytes: Uint8Array): Document => ({ type: 'BYTES_64', data: Buffer.from(bytes).toString('base64') });
const itemData = async (deps: SemogStorageLiberacaoDeps, envelopeId: string) =>
  (
    await deps.client.envelopeItem.findFirstOrThrow({
      where: { envelopeId },
      include: { documentData: true },
    })
  ).documentData;

/** Bridge membership without a snapshot: a draft receipt, as the portal's draft leaves. */
const draftReceipt = (deps: SemogStorageLiberacaoDeps, envelopeId: string) =>
  deps.sql(`INSERT INTO semog_bridge.draft_receipts("operacaoId","externalId","teamId","userId",hash,"envelopeId",resultado)
    VALUES(gen_random_uuid(),gen_random_uuid(),${deps.actor.teamId},${deps.actor.userId},repeat('a',64),'${envelopeId}','{}')`);
/** Cancelled as the bridge leaves it (snapshots revoked first), optionally with its receipt, N days ago. */
const cancel = (deps: SemogStorageLiberacaoDeps, envelopeId: string, daysAgo: number, receipt: boolean) =>
  deps.sql(`BEGIN;
    UPDATE semog_bridge.snapshots SET "revogadaEm"=clock_timestamp() WHERE "envelopeId"='${envelopeId}' AND "revogadaEm" IS NULL;
    UPDATE public."Envelope" SET status='CANCELLED', "completedAt"=clock_timestamp()-interval '${daysAgo} days'
      WHERE id='${envelopeId}';
    ${
      receipt
        ? `INSERT INTO semog_bridge.cancel_receipts("chaveOperacao","envelopeId","teamId","userId",motivo,hash,resultado)
      VALUES(gen_random_uuid(),'${envelopeId}',${deps.actor.teamId},${deps.actor.userId},'Teste',repeat('c',64),'{}');`
        : ''
    }
    COMMIT;`);

/** A PENDING envelope whose only obstacle is a seal waiting in the outbox (signature done, snapshot revoked). */
const sealQueued = async (deps: SemogStorageLiberacaoDeps) => {
  const fixture = await deps.createEnvelope(inline(await deps.pdf('pendente-selo-na-fila')));
  await deps.signAndSeal(fixture, false);
  await deps.sql(`WITH op AS (INSERT INTO semog_bridge.operations("chaveOperacao","snapshotId","teamId","envelopeId",
      "recipientId","hashDocumento","hashConsentimento",acao,"hashPedido",pedido,evidencias,estado)
    SELECT gen_random_uuid(),id,"teamId","envelopeId","recipientId","hashDocumento","hashConsentimento",'assinar',
      repeat('b',64),'{}','{}','concluida' FROM semog_bridge.snapshots WHERE "envelopeId"='${fixture.envelopeId}'
    RETURNING "chaveOperacao","envelopeId")
    INSERT INTO semog_bridge.outbox(id,"chaveOperacao","envelopeId",kind,payload)
      SELECT gen_random_uuid()::text,"chaveOperacao","envelopeId",'seal','{}' FROM op;
    UPDATE semog_bridge.snapshots SET "revogadaEm"=clock_timestamp() WHERE "envelopeId"='${fixture.envelopeId}';`);
  return fixture;
};
/**
 * The documented command, for real: under vite-node an "am I main" check used to make it exit 0 with no output.
 * A dry run against this database must print the plan, with the reason and the date for a busy PENDING envelope.
 */
const checkMigrationScriptRuns = async (deps: SemogStorageLiberacaoDeps, busyEnvelopeId: string) => {
  const dry = await runScript(deps, 'scripts/semog-signing-storage-migration.ts', []);
  assert(
    dry.code === 0 &&
      /Simulação: nada foi alterado/.test(dry.output) &&
      new RegExp(`envelope=${busyEnvelopeId}  status=PENDING  fora: .*elegível a partir de 2099-01-01`).test(
        dry.output,
      ),
    `script de migração em simulação não relatou o plano: ${JSON.stringify(dry.output.slice(0, 400))}`,
  );
};

const checkPendingEligibility = async (deps: SemogStorageLiberacaoDeps) => {
  const bytes = await deps.pdf('pendente-quieto');
  const quiet = await deps.createEnvelope(inline(bytes));
  await draftReceipt(deps, quiet.envelopeId);
  const busy = await deps.createEnvelope(inline(await deps.pdf('pendente-inscrito')));
  await deps.signAndSeal(busy, false);
  const reserved = await deps.createEnvelope(inline(await deps.pdf('pendente-operacao')));
  await deps.signAndSeal(reserved, false);
  // A reserved, unexecuted signature; its snapshot revoked so that only the operation can hold the migration back.
  await deps.sql(`INSERT INTO semog_bridge.operations("chaveOperacao","snapshotId","teamId","envelopeId","recipientId",
      "hashDocumento","hashConsentimento",acao,"hashPedido",pedido,evidencias)
    SELECT gen_random_uuid(),id,"teamId","envelopeId","recipientId","hashDocumento","hashConsentimento",'assinar',
      repeat('b',64),'{}','{}' FROM semog_bridge.snapshots WHERE "envelopeId"='${reserved.envelopeId}';
    UPDATE semog_bridge.snapshots SET "revogadaEm"=clock_timestamp() WHERE "envelopeId"='${reserved.envelopeId}';`);
  const queued = await sealQueued(deps);
  const plan = new Map((await planSemogStorageMigration(deps.client)).map((row) => [row.envelopeId, row]));
  const quietRow = plan.get(quiet.envelopeId);
  if (quietRow?.eligible !== true || quietRow.status !== 'PENDING') {
    throw new Error('PENDING quieto deveria ser elegível');
  }
  for (const [fixture, motivo] of [
    [busy, /inscrição ativa de quem não assinou até 2099-01-01T00:00:00\.000Z/],
    [reserved, /assinatura em andamento/],
    [queued, /selagem na fila/],
  ] as const) {
    const row = plan.get(fixture.envelopeId);
    if (row?.eligible !== false || !motivo.test(row.motivo ?? '')) {
      throw new Error(`PENDING ocupado elegível ou sem motivo claro: ${row?.motivo ?? 'ausente'}`);
    }
    await rejects(() => migrateSemogStorageRow(deps.client, deps.store, row), /not eligible/, 'migrou PENDING ocupado');
  }
  assert(plan.get(busy.envelopeId)?.elegivelEm?.toISOString() === '2099-01-01T00:00:00.000Z', 'data de elegibilidade');
  await checkMigrationScriptRuns(deps, busy.envelopeId);
  await migrateSemogStorageRow(deps.client, deps.store, quietRow);
  const migrated = await itemData(deps, quiet.envelopeId);
  assert(migrated.type === 'S3_PATH' && migrated.data === keyOf(bytes), 'PENDING não foi para a chave do hash');
  const read = await readSemogStoredPdf(deps.store, migrated.data);
  assert(Buffer.from(read).equals(Buffer.from(bytes)), 'bytes lidos do R2 divergem do inline');
  // Enrolled only after the migration: the snapshot binds the key, and the envelope still signs and seals.
  await deps.signAndSeal(quiet, true);
  return { completedOriginalKey: keyOf(bytes) };
};

const checkCancelledGuard = async (deps: SemogStorageLiberacaoDeps) => {
  const noReceipt = await deps.createEnvelope(await putSemogStoredPdf(deps.store, await deps.pdf('cancelado-nativo')));
  await deps.signAndSeal(noReceipt, false);
  await cancel(deps, noReceipt.envelopeId, 100, false);
  const withReceipt = await deps.createEnvelope(inline(await deps.pdf('ata-de-teste')));
  await draftReceipt(deps, withReceipt.envelopeId);
  await cancel(deps, withReceipt.envelopeId, 5, true);
  for (const fixture of [noReceipt, withReceipt]) {
    const row = await itemData(deps, fixture.envelopeId);
    await rejects(
      () => deps.sql(`UPDATE public."DocumentData" SET data='semog/pdf/x.pdf' WHERE id='${row.id}'`),
      /keeps its PDF row/,
      'UPDATE direto em PDF de cancelado passou',
    );
    await rejects(
      () => deps.sql(`DELETE FROM public."DocumentData" WHERE id='${row.id}'`),
      /keeps its PDF row/,
      'DELETE de PDF de cancelado passou',
    );
    await rejects(
      () => deps.sql(`UPDATE public."DocumentData" SET id='${row.id}-x' WHERE id='${row.id}'`),
      /keeps its PDF row/,
      'troca de id de PDF de cancelado passou',
    );
  }
  const inlineRow = await itemData(deps, withReceipt.envelopeId);
  await rejects(
    () =>
      deps.sql(`BEGIN; SELECT set_config('semog_bridge.storage_migration',gen_random_uuid()::text,true);
        UPDATE public."DocumentData" SET type='S3_PATH', data=semog_bridge.semog_pdf_key(data),
          "initialData"=semog_bridge.semog_pdf_key("initialData") WHERE id='${inlineRow.id}'; COMMIT;`),
    /keeps its PDF row/,
    'token forjado passou pela guarda do cancelado',
  );
  return { noReceipt, withReceipt };
};

/** Real MinIO objects with the clock shifted two days back: the retention/sharing rules run against real deletes. */
const aged = (objects: SemogPurgeObjects): SemogPurgeObjects => ({
  ...objects,
  lastModified: async (key) => {
    const modified = await objects.lastModified(key);
    return modified && new Date(modified.getTime() - 48 * 3_600_000);
  },
});
const stored = async (deps: SemogStorageLiberacaoDeps, label: string) =>
  await putSemogStoredPdf(deps.store, await deps.pdf(label));
const cancelledWith = async (deps: SemogStorageLiberacaoDeps, document: Document, daysAgo: number) => {
  const fixture = await deps.createEnvelope(document);
  await draftReceipt(deps, fixture.envelopeId);
  await cancel(deps, fixture.envelopeId, daysAgo, false);
  return fixture;
};
const exists = async (objects: SemogPurgeObjects, key: string) => (await objects.lastModified(key)) !== null;

const setupPurgeCases = async (deps: SemogStorageLiberacaoDeps, completedOriginalKey: string) => {
  const unique = await stored(deps, 'cancelado-unico');
  const shared = await stored(deps, 'compartilhado');
  // Cancelled after a partial seal: its original (the item) and the round's sealed PDF.
  const sealedOriginal = await stored(deps, 'original-com-selo-parcial');
  const sealedRound = await stored(deps, 'pdf-do-selo-parcial');
  const recent = await stored(deps, 'cancelado-recente');
  const cases = {
    unique: await cancelledWith(deps, unique, 100),
    shared: await cancelledWith(deps, shared, 100),
    original: await cancelledWith(deps, { type: 'S3_PATH', data: completedOriginalKey }, 100),
    sealedPart: await cancelledWith(deps, sealedOriginal, 100),
    recent: await cancelledWith(deps, recent, 10),
  };
  // Same bytes, live elsewhere (dedupe): a PENDING envelope outside the bridge keeps the object.
  await deps.createEnvelope(shared);
  // The real shape (partial-seal-service): data = the round's PDF, initialData = the original's key.
  await deps.sql(`INSERT INTO public."DocumentData"(id,type,data,"initialData")
      VALUES('partial-seal-row','S3_PATH','${sealedRound.data}','${sealedOriginal.data}');
    INSERT INTO semog_bridge.partial_seals("chaveOperacao","teamId","envelopeId",rodada,"documentDataId","hashPdf",assinantes)
      VALUES(gen_random_uuid(),${deps.actor.teamId},'${cases.sealedPart.envelopeId}',1,'partial-seal-row',
        '${sealedRound.data.slice(10, 74)}','[1]');`);
  return {
    keys: { unique, shared, sealedOriginal, sealedRound, recent, original: completedOriginalKey },
    cases,
  };
};

const purgeOptions = { retentionDays: 90, graceHours: 24, immediateEnvelopeId: null, quem: 'teste-local' };
const checkRetentionPurge = async (deps: SemogStorageLiberacaoDeps, completedOriginalKey: string) => {
  const real = createSemogS3PurgeObjects(deps.settings);
  const objects = aged(real);
  const ledger = createSemogPurgeLedger(deps.client);
  const { keys, cases } = await setupPurgeCases(deps, completedOriginalKey);
  const dry = await runSemogStoragePurge({ ledger, objects }, { ...purgeOptions, apply: false });
  assert(
    dry.map((item) => item.chave).includes(keys.unique.data) && (await exists(real, keys.unique.data)),
    'simulação deveria listar sem apagar',
  );
  const outcomes = await runSemogStoragePurge({ ledger, objects }, { ...purgeOptions, apply: true });
  const purged = outcomes.filter((item) => item.resultado === 'purgada').map((item) => item.chave);
  assert(purged.includes(keys.unique.data), `chave única não purgada: ${JSON.stringify(outcomes)}`);
  for (const [name, key] of [
    ['compartilhada (dedupe)', keys.shared.data],
    ['initialData de COMPLETED', keys.original],
    // Decision (30/10): cancelled after a partial seal keeps both objects in R2 for good — the round is proof of
    // signature, and it points at the original through initialData.
    ['original de cancelado com selo parcial', keys.sealedOriginal.data],
    ['PDF do selo parcial', keys.sealedRound.data],
    ['cancelado há 10 dias', keys.recent.data],
  ]) {
    assert(!purged.includes(key) && (await exists(real, key)), `purgou ${name}`);
  }
  assert(!(await exists(real, keys.unique.data)), 'objeto purgado continua no bucket');
  const row = await itemData(deps, cases.unique.envelopeId);
  assert(row.type === 'S3_PATH' && row.data === keys.unique.data, 'a purga mexeu na linha de DocumentData');
  const record = await deps.sql(`SELECT estado||'|'||array_to_string(envelopes,',')||'|'||"retencaoDias"||'|'||quem
    FROM semog_bridge.storage_purges WHERE chave='${keys.unique.data}'`);
  assert(record === `purgada|${cases.unique.envelopeId}|90|teste-local`, `registro da purga: ${record}`);
  const again = await runSemogStoragePurge({ ledger, objects }, { ...purgeOptions, apply: true });
  assert(!again.some((item) => item.chave === keys.unique.data), 'purga não é idempotente');
  return { ledger, real, objects, cases, keys };
};

const checkResumeAndGrace = async (
  deps: SemogStorageLiberacaoDeps,
  purge: Awaited<ReturnType<typeof checkRetentionPurge>>,
) => {
  // Crash after the removal, before the conclusion: the pending intent is resumed and closed as 'ausente'.
  const crashed = await stored(deps, 'queda-no-meio');
  await cancelledWith(deps, crashed, 100);
  await deps.sql(`SELECT semog_bridge.storage_purge_begin('${crashed.data}',90,NULL,'Retenção','teste-local')`);
  await purge.real.remove(crashed.data);
  const resumed = await runSemogStoragePurge(
    { ledger: purge.ledger, objects: purge.objects },
    { ...purgeOptions, apply: true },
  );
  assert(
    resumed.some((item) => item.chave === crashed.data && item.resultado === 'ausente'),
    'intenção pendente não retomada',
  );
  const absent = await deps.sql(
    `SELECT estado||'|'||"objetoAusente" FROM semog_bridge.storage_purges WHERE chave='${crashed.data}'`,
  );
  assert(absent === 'purgada|true', `retomada registrada errado: ${absent}`);
  // Daily sweep with the real clock: the object was just written, so the grace keeps it and says so.
  const fresh = await stored(deps, 'gravado-agora');
  await cancelledWith(deps, fresh, 100);
  // One cancelled inline row whose upload the bucket refuses, one that goes through: the first must not stop the second.
  const refusedBytes = await deps.pdf('inline-recusado-pelo-bucket');
  const refused = await cancelledWith(deps, inline(refusedBytes), 100);
  const accepted = await cancelledWith(deps, inline(await deps.pdf('inline-aceito')), 100);
  // An inline row of nobody, with bytes that do not even decode: the sweep's plan must never touch it.
  await deps.sql(
    `INSERT INTO public."DocumentData"(id,type,data,"initialData") VALUES('inline-corrompida','BYTES_64','%%%','%%%')`,
  );
  const errors: string[] = [];
  const failure = await sweepFailure(deps, errors, (settings) => {
    const objects = createSemogS3PurgeObjects(settings);
    return {
      ...objects,
      write: (key, value) =>
        key === keyOf(refusedBytes) ? Promise.reject(new Error('bucket recusou')) : objects.write(key, value),
    };
  });
  await deps.sql(`DELETE FROM public."DocumentData" WHERE id='inline-corrompida'`);
  assert(/PARTIAL FAILURE \(1\)/.test(failure), `o job com falha parcial deveria terminar falho: ${failure}`);
  assert(await exists(purge.real, fresh.data), 'carência apagou o objeto');
  const deferred = await deps.sql(`SELECT count(*) FROM semog_bridge.storage_purges WHERE chave='${fresh.data}'`);
  assert(deferred === '0', `adiamento pela carência virou linha permanente (${deferred})`);
  const refusedRow = await itemData(deps, refused.envelopeId);
  assert(
    refusedRow.type === 'BYTES_64' && (await itemData(deps, accepted.envelopeId)).type === 'S3_PATH',
    'falha de uma linha inline derrubou a outra',
  );
  assert(
    errors.some((line) => line.includes(`inline migration failed for DocumentData ${refusedRow.id}`)) &&
      errors.some((line) => /PARTIAL FAILURE/.test(line)),
    `falha parcial não apareceu no log do job: ${JSON.stringify(errors)}`,
  );
  await checkCorruptedObjectFailsTheJob(deps);
};
/** Runs the daily sweep and returns the message it ended with: it must END FAILED (throw) after doing everything. */
const sweepFailure = async (
  deps: SemogStorageLiberacaoDeps,
  errors: string[],
  createObjects: (settings: SemogS3Settings) => SemogPurgeObjects,
) => {
  const env: Record<string, string | undefined> = { ...process.env, SEMOG_SIGNING_ENABLED: 'true' };
  try {
    await sweepSemogCancelledStorage({
      client: deps.client,
      read: (name) => env[name],
      createObjects,
      log: { info: () => undefined, error: (message) => errors.push(message) },
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'a varredura terminou sem falhar';
};
/** An object whose bytes do not hash to its key is corruption: kept, closed as 'desistida', and the job fails. */
const checkCorruptedObjectFailsTheJob = async (deps: SemogStorageLiberacaoDeps) => {
  const corrupted = await stored(deps, 'objeto-corrompido');
  await cancelledWith(deps, corrupted, 100);
  const s3 = new S3Client({
    ...deps.settings,
    region: deps.settings.region ?? 'us-east-1',
    forcePathStyle: deps.settings.forcePathStyle === true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  await s3.send(
    new PutObjectCommand({ Bucket: deps.settings.bucket, Key: corrupted.data, Body: await deps.pdf('outros-bytes') }),
  );
  const errors: string[] = [];
  const failure = await sweepFailure(deps, errors, (settings) => aged(createSemogS3PurgeObjects(settings)));
  assert(/PARTIAL FAILURE \(1\)/.test(failure), `objeto corrompido deveria falhar o job: ${failure}`);
  assert(
    errors.some((line) => line.includes(`divergente: ${corrupted.data}`)),
    `divergência sem log de erro: ${errors}`,
  );
  const record = await deps.sql(
    `SELECT estado||'|'||observacao FROM semog_bridge.storage_purges WHERE chave='${corrupted.data}'`,
  );
  assert(record.startsWith('desistida|SHA-256 divergente'), `registro do objeto corrompido: ${record}`);
  assert(await exists(createSemogS3PurgeObjects(deps.settings), corrupted.data), 'objeto corrompido foi apagado');
};

const runScript = (deps: SemogStorageLiberacaoDeps, script: string, args: string[]) =>
  new Promise<{ code: number | null; output: string }>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/vite-node/vite-node.mjs', '--config', 'packages/lib/vitest.config.ts', script, ...args],
      { env: { ...process.env, NEXT_PRIVATE_DATABASE_URL: deps.databaseUrl } },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, output }));
  });
const runCli = (deps: SemogStorageLiberacaoDeps, args: string[]) =>
  runScript(deps, 'scripts/semog-signing-storage-purge.ts', args);
const checkCli = async (deps: SemogStorageLiberacaoDeps, ata: Fixture, pending: Fixture) => {
  const real = createSemogS3PurgeObjects(deps.settings);
  const flags = ['--envelope', ata.envelopeId, '--agora', '--motivo', 'Ata de teste', '--carencia-horas', '0'];
  const dry = await runCli(deps, flags);
  assert(
    dry.code === 0 && /seriam migradas/.test(dry.output) && /Simulação/.test(dry.output),
    `simulação: ${dry.output}`,
  );
  assert((await itemData(deps, ata.envelopeId)).type === 'BYTES_64', 'simulação alterou a linha');
  const refused = await runCli(deps, ['--envelope', pending.envelopeId, '--agora', '--motivo', 'x', '--aplicar']);
  assert(
    refused.code === 1 && /não é um envelope CANCELLED/.test(refused.output),
    `--agora em não cancelado: ${refused.output}`,
  );
  const applied = await runCli(deps, [...flags, '--aplicar']);
  assert(applied.code === 0 && /purgada/.test(applied.output), `aplicação: ${applied.output}`);
  const row = await itemData(deps, ata.envelopeId);
  assert(row.type === 'S3_PATH' && !(await exists(real, row.data)), 'ata de teste não migrada e purgada');
  const record = await deps.sql(
    `SELECT motivo||'|'||"envelopeImediato" FROM semog_bridge.storage_purges WHERE chave='${row.data}'`,
  );
  assert(record === `Ata de teste|${ata.envelopeId}`, `registro da purga imediata: ${record}`);
};

const checkLedgerProtection = async (deps: SemogStorageLiberacaoDeps) => {
  const id = await deps.sql(`SELECT id FROM semog_bridge.storage_purges ORDER BY "registradaEm" LIMIT 1`);
  for (const [statement, label] of [
    [`DELETE FROM semog_bridge.storage_purges WHERE id='${id}'`, 'DELETE'],
    [`TRUNCATE semog_bridge.storage_purges`, 'TRUNCATE'],
    [`UPDATE semog_bridge.storage_purges SET motivo='outro' WHERE id='${id}'`, 'UPDATE'],
    [
      `BEGIN; SELECT set_config('semog_bridge.storage_purge','${randomUUID()}',true);
       INSERT INTO semog_bridge.storage_purges(id,chave,sha256,envelopes,motivo,"retencaoDias",quem,estado)
       VALUES('${randomUUID()}','semog/pdf/${'0'.repeat(64)}.pdf','${'0'.repeat(64)}','{x}','forjado',90,'eu','pendente'); COMMIT;`,
      'INSERT com marca forjada',
    ],
  ]) {
    await rejects(
      () => deps.sql(statement),
      /permanent|only through the purge functions/,
      `${label} no registro passou`,
    );
  }
};
const LIBERACAO_FUNCTIONS = [
  'storage_cancelled_owner(text)',
  'storage_purges_guard()',
  'storage_purgeable_context(text,integer,text)',
  'storage_purge_candidates(integer,text)',
  'storage_purge_begin(text,integer,text,text,text)',
  'storage_purge_finish(uuid,boolean)',
  'storage_purge_abandon(uuid,text)',
  'storage_purge_arm(uuid)',
  'storage_purge_disarm(uuid)',
];
const checkAcl = async (deps: SemogStorageLiberacaoDeps) => {
  const others = await deps.sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN pg_roles r WHERE n.nspname='semog_bridge' AND r.oid<>p.proowner AND NOT r.rolsuper
      AND (p.proname LIKE 'storage\\_purge%' OR p.proname='storage_cancelled_owner')
      AND has_function_privilege(r.oid,p.oid,'EXECUTE')`);
  assert(others === '0', `papéis com EXECUTE nas funções de purga: ${others}`);
  for (const role of ['intruso', 'semog_bridge_service']) {
    for (const fn of LIBERACAO_FUNCTIONS) {
      const granted = await deps.sql(`SELECT has_function_privilege('${role}','semog_bridge.${fn}','EXECUTE')`);
      assert(granted === 'f', `${role} pode executar ${fn}`);
    }
    for (const table of ['storage_purges', 'storage_purge_tokens']) {
      const granted = await deps.sql(
        `SELECT has_table_privilege('${role}','semog_bridge.${table}','INSERT,SELECT,UPDATE,DELETE,TRUNCATE')`,
      );
      assert(granted === 'f', `${role} acessa ${table}`);
    }
  }
};
const checkDownUp = async (deps: SemogStorageLiberacaoDeps, cancelledRowId: string) => {
  const records = await deps.sql('SELECT count(*) FROM semog_bridge.storage_purges');
  await deps.migration('storage-liberacao', 'down');
  assert(
    (await deps.sql(`SELECT to_regprocedure('semog_bridge.storage_purge_begin(text,integer,text,text,text)') IS NULL
      AND to_regclass('semog_bridge.storage_purges') IS NOT NULL`)) === 't',
    'down deveria remover as funções e manter o registro com dados',
  );
  // Back to 2026-10-31: the cancelled row is unguarded again (proved inside a rolled-back transaction).
  await deps.sql(`BEGIN; UPDATE public."DocumentData" SET data=data WHERE id='${cancelledRowId}'; ROLLBACK;`);
  await deps.migration('storage-liberacao');
  await deps.migration('storage-liberacao');
  assert(
    (await deps.sql('SELECT count(*) FROM semog_bridge.storage_purges')) === records,
    'registros perdidos no down/up',
  );
  await rejects(
    () => deps.sql(`UPDATE public."DocumentData" SET data=data WHERE id='${cancelledRowId}'`),
    /keeps its PDF row/,
    'guarda não voltou depois do up',
  );
};

export const checkSemogStorageLiberacaoLocal = async (deps: SemogStorageLiberacaoDeps) => {
  const { completedOriginalKey } = await checkPendingEligibility(deps);
  const cancelled = await checkCancelledGuard(deps);
  const pendingOther = await deps.createEnvelope(inline(await deps.pdf('nao-cancelado')));
  await draftReceipt(deps, pendingOther.envelopeId);
  await checkCli(deps, cancelled.withReceipt, pendingOther);
  const purge = await checkRetentionPurge(deps, completedOriginalKey);
  await checkResumeAndGrace(deps, purge);
  await checkLedgerProtection(deps);
  await checkAcl(deps);
  await checkDownUp(deps, (await itemData(deps, cancelled.noReceipt.envelopeId)).id);
};
