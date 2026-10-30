import { Prisma } from '@prisma/client';

import type { SemogS3Settings } from './pdf-store-s3';
import { semogS3SettingsFromEnv } from './pdf-store-s3';
import { migrateSemogCancelledInline } from './storage-migration';
import type { SemogPurgeObjects, SemogPurgeOutcome } from './storage-purge';
import { createSemogPurgeLedger, readSemogPurgeSettings, runSemogStoragePurge } from './storage-purge';

type SqlClient = Pick<Prisma.TransactionClient, '$queryRaw'>;
export type SemogPurgeSweepDeps = {
  client: SqlClient;
  read: (name: string) => string | undefined;
  createObjects: (settings: SemogS3Settings) => SemogPurgeObjects;
  log: { info: (message: string) => void; error: (message: string) => void };
};
const FAILED: SemogPurgeOutcome['resultado'][] = ['erro', 'conflito'];

const migrationApplied = async (client: SqlClient) => {
  const rows = await client.$queryRaw<{ ready: boolean }[]>(
    Prisma.sql`SELECT to_regprocedure('semog_bridge.storage_purge_begin(text,integer,text,text,text)') IS NOT NULL ready`,
  );
  return rows[0]?.ready === true;
};
/** Why the sweep does nothing on this host, or null when it should run. Never a silent no-op: the reason is logged. */
const skipReason = async ({ client, read }: SemogPurgeSweepDeps) => {
  if (read('SEMOG_SIGNING_ENABLED') !== 'true') {
    return 'ponte desligada (SEMOG_SIGNING_ENABLED)';
  }
  if (read('SEMOG_STORAGE_PURGE_ENABLED') === 'false') {
    return 'purga desligada (SEMOG_STORAGE_PURGE_ENABLED=false)';
  }
  if (!(await migrationApplied(client))) {
    return 'migração db/2026-11-01-semog-storage-liberacao.sql ausente';
  }
  return null;
};
/**
 * Daily: cancelled envelopes' inline PDFs go to R2 first, then every object past the retention is removed through
 * the database's permanent record. Logs keys and envelope ids only — no PDF content, no credential.
 */
export const sweepSemogCancelledStorage = async (deps: SemogPurgeSweepDeps): Promise<SemogPurgeOutcome[]> => {
  const skip = await skipReason(deps);
  const settings = skip === null ? semogS3SettingsFromEnv(deps.read) : undefined;
  if (skip !== null || !settings) {
    deps.log.info(`Semog storage purge skipped: ${skip ?? 'transporte de upload não é s3'}.`);
    return [];
  }
  const objects = deps.createObjects(settings);
  const inline = await migrateSemogCancelledInline(deps.client, objects, null);
  for (const failure of inline.failed) {
    deps.log.error(
      `Semog storage purge: inline migration failed for DocumentData ${failure.id} [${failure.envelopeId ?? '-'}]: ${failure.erro}`,
    );
  }
  const outcomes = await runSemogStoragePurge(
    { ledger: createSemogPurgeLedger(deps.client), objects },
    {
      ...readSemogPurgeSettings(deps.read),
      immediateEnvelopeId: null,
      quem: 'job:semog-storage-purge-sweep',
      apply: true,
    },
  );
  for (const item of outcomes) {
    const line = `Semog storage purge ${item.resultado}: ${item.chave} [${item.envelopes.join(',')}]${item.detalhe ? ` ${item.detalhe}` : ''}`;
    (FAILED.includes(item.resultado) ? deps.log.error : deps.log.info)(line);
  }
  const failures = inline.failed.length + outcomes.filter((item) => FAILED.includes(item.resultado)).length;
  const summary = `Semog storage purge: ${inline.migrated.length} inline migrated, ${inline.failed.length} inline failed, ${outcomes.length} key(s) handled`;
  // A partial failure is said once more at error level, so the job log shows it without reading every line.
  if (failures > 0) {
    deps.log.error(`${summary}; PARTIAL FAILURE (${failures}).`);
  } else {
    deps.log.info(`${summary}.`);
  }
  return outcomes;
};
