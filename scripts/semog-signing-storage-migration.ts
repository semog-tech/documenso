/**
 * Moves the bridge's inline PDFs (DocumentData BYTES_64) to object storage (S3_PATH, content-addressed key), one
 * row at a time, without disabling any trigger. Requires db/2026-10-31-semog-storage.sql applied.
 *
 *   Simulação (padrão, não grava nada):
 *     node24 node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts \
 *       scripts/semog-signing-storage-migration.ts
 *   Execução real (só com as duas flags):
 *     ... scripts/semog-signing-storage-migration.ts --aplicar --backup /opt/documenso/backup-documentdata.jsonl
 *
 * Environment: NEXT_PRIVATE_DATABASE_URL and the native upload settings (NEXT_PRIVATE_UPLOAD_BUCKET, _ENDPOINT,
 * _REGION, _FORCE_PATH_STYLE, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY) — the same the Documenso container uses.
 * Per row: decode -> upload under semog/pdf/<sha256>.pdf -> read back and compare SHA-256 -> only then the
 * database function swaps the row, recomputing the keys from the bytes it holds. Afterwards, run (instruction
 * only, not automated): VACUUM FULL public."DocumentData"; — it locks the table while it rewrites it.
 */
import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { createSemogPdfReader } from '../packages/lib/server-only/semog-signing/initial-pdf';
import type { SemogPdfStore } from '../packages/lib/server-only/semog-signing/pdf-store';
import { putSemogStoredPdf, semogPdfKeyFor } from '../packages/lib/server-only/semog-signing/pdf-store';
import { createSemogS3PdfStore } from '../packages/lib/server-only/semog-signing/pdf-store-s3';

type SqlClient = Pick<PrismaClient, '$queryRaw'>;
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
};
type PlanQueryRow = Omit<SemogStoragePlanRow, 'eligible' | 'motivo'> & { finished: boolean | null };

const reason = (row: PlanQueryRow) => {
  if (row.envelopeId === null) {
    return 'órfã sem vínculo comprovado com envelope da ponte';
  }
  if (!row.ponte) {
    return 'envelope fora da ponte';
  }
  return row.finished === true ? null : `envelope ${row.status ?? '?'} com assinatura, selagem ou inscrição pendente`;
};
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
      CASE WHEN o.env IS NULL THEN NULL ELSE semog_bridge.storage_migration_eligible(o.env) END finished
    FROM public."DocumentData" d
    CROSS JOIN LATERAL (SELECT semog_bridge.storage_owner(d.id) direct) owner
    CROSS JOIN LATERAL (SELECT COALESCE(owner.direct, semog_bridge.storage_orphan_owner(d.id)) env,
      owner.direct IS NULL orfa) o
    LEFT JOIN public."Envelope" e ON e.id=o.env
    WHERE d.type='BYTES_64' ORDER BY d.id`);
  return rows.map((row) => {
    const motivo = reason(row);
    const { finished: _finished, ...plan } = row;
    return { ...plan, eligible: motivo === null, motivo };
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

const storeFromEnvironment = () => {
  const bucket = process.env.NEXT_PRIVATE_UPLOAD_BUCKET;
  const accessKeyId = process.env.NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID;
  const secretAccessKey = process.env.NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY;
  if (!bucket) {
    throw new Error('NEXT_PRIVATE_UPLOAD_BUCKET ausente.');
  }
  return createSemogS3PdfStore({
    bucket,
    endpoint: process.env.NEXT_PRIVATE_UPLOAD_ENDPOINT || undefined,
    region: process.env.NEXT_PRIVATE_UPLOAD_REGION || undefined,
    forcePathStyle: process.env.NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE === 'true',
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  });
};
const printPlan = (plan: SemogStoragePlanRow[]) => {
  for (const row of plan) {
    const situacao = row.eligible ? 'ELEGÍVEL' : `fora: ${row.motivo}`;
    process.stdout.write(
      `${row.id}  ${(row.bytes / 1048576).toFixed(1)} MiB  ${row.dataKey}  envelope=${row.envelopeId ?? '-'}${row.orfa ? ' (original órfão)' : ''}  ${situacao}\n`,
    );
  }
  process.stdout.write(`${plan.filter((row) => row.eligible).length} de ${plan.length} elegíveis.\n`);
};
const main = async () => {
  const apply = process.argv.includes('--aplicar');
  const backupAt = process.argv.indexOf('--backup');
  const backup = backupAt > 0 ? process.argv[backupAt + 1] : undefined;
  if (backupAt > 0 && (!backup || backup.startsWith('--'))) {
    throw new Error('--backup exige o caminho de um arquivo novo logo em seguida.');
  }
  if (apply && !backup) {
    throw new Error('--aplicar exige --backup <arquivo.jsonl> (arquivo novo; não sobrescreve).');
  }
  const client = new PrismaClient({ datasourceUrl: process.env.NEXT_PRIVATE_DATABASE_URL });
  try {
    const plan = await planSemogStorageMigration(client);
    printPlan(plan);
    if (!apply || !backup) {
      process.stdout.write('Simulação: nada foi alterado. Use --aplicar --backup <arquivo> para executar.\n');
      return;
    }
    const eligible = plan.filter((row) => row.eligible);
    await backupSemogStorageRows(
      client,
      eligible.map((row) => row.id),
      backup,
    );
    const store = storeFromEnvironment();
    for (const row of eligible) {
      process.stdout.write(`migrada ${JSON.stringify(await migrateSemogStorageRow(client, store, row))}\n`);
    }
    process.stdout.write('Concluído. Depois, em janela calma: VACUUM FULL public."DocumentData";\n');
  } finally {
    await client.$disconnect();
  }
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
