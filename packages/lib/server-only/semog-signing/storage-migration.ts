import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { Prisma } from '@prisma/client';

import { createSemogPdfReader } from './initial-pdf';
import type { SemogPdfStore } from './pdf-store';
import { putSemogStoredPdf, semogPdfKeyFor } from './pdf-store';

/**
 * Inline (BYTES_64) -> object storage (S3_PATH) for the bridge's PDFs, one row at a time, through
 * semog_bridge.migrate_document_data_to_s3 (db/2026-10-31-semog-storage, widened by 2026-11-01-semog-storage-liberacao
 * to CANCELLED and quiet PENDING envelopes). Used by scripts/semog-signing-storage-migration.ts and by the purge,
 * which first moves a cancelled envelope's inline PDF to R2 so the retention can then remove it.
 */
type SqlClient = Pick<Prisma.TransactionClient, '$queryRaw'>;
export type SemogStoragePlanRow = {
  id: string;
  bytes: number;
  dataKey: string;
  initialKey: string;
  envelopeId: string | null;
  /** Unreferenced row, tied to its envelope only as the pre-seal original (same INITIAL_DATA as the sealed row). */
  orfa: boolean;
  status: string | null;
  ponte: boolean;
  eligible: boolean;
  motivo: string | null;
  /** When the only obstacle is a live enrollment: the latest expiraEm among them, from which the row qualifies. */
  elegivelEm: Date | null;
};
type PlanQueryRow = Omit<SemogStoragePlanRow, 'eligible' | 'motivo' | 'elegivelEm'> & {
  finished: boolean | null;
  inscricaoAte: Date | null;
  operacaoPendente: boolean;
  seloNaFila: boolean;
};

const ENCERRAVEIS = ['COMPLETED', 'REJECTED', 'CANCELLED', 'PENDING'];
/** Every obstacle the database function checks, named, so the dry run says why and until when. */
const obstacles = (row: PlanQueryRow) => [
  ...(ENCERRAVEIS.includes(row.status ?? '') ? [] : [`status ${row.status ?? '?'} fora da migração`]),
  ...(row.inscricaoAte ? [`inscrição ativa de quem não assinou até ${row.inscricaoAte.toISOString()}`] : []),
  ...(row.operacaoPendente ? ['assinatura em andamento'] : []),
  ...(row.seloNaFila ? ['selagem na fila'] : []),
];
const reason = (row: PlanQueryRow) => {
  if (row.envelopeId === null) {
    return 'órfã sem vínculo comprovado com envelope da ponte';
  }
  if (!row.ponte) {
    return 'envelope fora da ponte';
  }
  if (row.finished === true) {
    return null;
  }
  const named = obstacles(row);
  return `envelope ${row.status ?? '?'}: ${named.length > 0 ? named.join('; ') : 'não encerrado'}`;
};
const eligibleFrom = (row: PlanQueryRow) =>
  row.finished !== true && row.inscricaoAte !== null && obstacles(row).length === 1 ? row.inscricaoAte : null;
export const planSemogStorageMigration = async (client: SqlClient): Promise<SemogStoragePlanRow[]> => {
  const ready = await client.$queryRaw<{ ready: boolean }[]>(
    Prisma.sql`SELECT to_regprocedure('semog_bridge.migrate_document_data_to_s3(text,text,text)') IS NOT NULL ready`,
  );
  if (ready[0]?.ready !== true) {
    throw new Error('Migração db/2026-10-31-semog-storage.sql ausente: nada foi lido nem alterado.');
  }
  const rows = await client.$queryRaw<PlanQueryRow[]>(Prisma.sql`
    SELECT d.id, octet_length(decode(d.data,'base64'))::int bytes,
      semog_bridge.semog_pdf_key(d.data) "dataKey", semog_bridge.semog_pdf_key(d."initialData") "initialKey",
      o.env "envelopeId", o.orfa, e.status::text status,
      COALESCE(semog_bridge.storage_is_bridge_envelope(o.env),false) ponte,
      CASE WHEN o.env IS NULL THEN NULL ELSE semog_bridge.storage_migration_eligible(o.env) END finished,
      (SELECT max(s."expiraEm") FROM semog_bridge.snapshots s JOIN public."Recipient" r ON r.id=s."recipientId"
        WHERE s."envelopeId"=o.env AND s."revogadaEm" IS NULL AND s."expiraEm">clock_timestamp()
          AND r."signingStatus"='NOT_SIGNED') "inscricaoAte",
      EXISTS(SELECT 1 FROM semog_bridge.operations WHERE "envelopeId"=o.env AND estado='pendente') "operacaoPendente",
      EXISTS(SELECT 1 FROM semog_bridge.outbox WHERE "envelopeId"=o.env AND kind='seal'
        AND estado IN ('pendente','leased')) "seloNaFila"
    FROM public."DocumentData" d
    CROSS JOIN LATERAL (SELECT semog_bridge.storage_owner(d.id) direct) owner
    CROSS JOIN LATERAL (SELECT COALESCE(owner.direct, semog_bridge.storage_orphan_owner(d.id)) env,
      owner.direct IS NULL orfa) o
    LEFT JOIN public."Envelope" e ON e.id=o.env
    WHERE d.type='BYTES_64' ORDER BY d.id`);
  return rows.map((row) => {
    const motivo = reason(row);
    const { finished: _finished, inscricaoAte: _until, operacaoPendente: _operation, seloNaFila: _seal, ...plan } = row;
    return { ...plan, eligible: motivo === null, motivo, elegivelEm: eligibleFrom(row) };
  });
};

const readInline = async (client: SqlClient, id: string) => {
  const rows = await client.$queryRaw<{ data: string; initialData: string }[]>(
    Prisma.sql`SELECT data, "initialData" FROM public."DocumentData" WHERE id=${id} AND type='BYTES_64'`,
  );
  if (rows.length !== 1) {
    throw new Error(`DocumentData ${id} não está mais inline; nada feito com ela.`);
  }
  return rows[0];
};
/** Upload, then prove the stored object is the very bytes before the row may point at it. */
const uploadVerified = async (store: SemogPdfStore, base64: string, expectedKey: string) => {
  const bytes = await createSemogPdfReader()({ documentDataId: 'migracao', type: 'BYTES_64', data: base64 });
  const key = semogPdfKeyFor(createHash('sha256').update(bytes).digest('hex'));
  if (key !== expectedKey) {
    throw new Error(`Chave calculada diverge da do banco (${key} != ${expectedKey}).`);
  }
  // Uploads and reads the object back, proving it by content before the row may point at it.
  await putSemogStoredPdf(store, bytes);
};
export const migrateSemogStorageRow = async (client: SqlClient, store: SemogPdfStore, row: SemogStoragePlanRow) => {
  const inline = await readInline(client, row.id);
  await uploadVerified(store, inline.data, row.dataKey);
  await uploadVerified(store, inline.initialData, row.initialKey);
  const result = await client.$queryRaw<{ result: unknown }[]>(
    Prisma.sql`SELECT semog_bridge.migrate_document_data_to_s3(${row.id},${row.dataKey},${row.initialKey}) result`,
  );
  return result[0]?.result;
};
/**
 * Full rows (Base64 included) go to a NEW local file before any change: evidence and a manual restore source.
 * There is no automated way back to BYTES_64 — the guard accepts only the inline -> content-address direction.
 */
export const backupSemogStorageRows = async (client: SqlClient, ids: string[], path: string) => {
  await writeFile(path, '', { flag: 'wx' });
  for (const id of ids) {
    const rows = await client.$queryRaw<{ line: string }[]>(
      Prisma.sql`SELECT to_jsonb(d)::text line FROM public."DocumentData" d WHERE id=${id}`,
    );
    await appendFile(path, `${rows[0].line}\n`);
  }
};
/**
 * Before the purge: a CANCELLED envelope's PDF still inline goes to R2 first (bytes proven, row swapped by the
 * database function), so the retention can later remove the object. Only eligible CANCELLED rows, optionally of one
 * envelope. Returns the ids moved.
 */
export const migrateSemogCancelledInline = async (
  client: SqlClient,
  store: SemogPdfStore,
  envelopeId: string | null,
): Promise<string[]> => {
  const rows = (await planSemogStorageMigration(client)).filter(
    (row) => row.eligible && row.status === 'CANCELLED' && (envelopeId === null || row.envelopeId === envelopeId),
  );
  for (const row of rows) {
    await migrateSemogStorageRow(client, store, row);
  }
  return rows.map((row) => row.id);
};
