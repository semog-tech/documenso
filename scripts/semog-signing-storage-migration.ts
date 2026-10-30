/**
 * Moves the bridge's inline PDFs (DocumentData BYTES_64) to object storage (S3_PATH, content-addressed key), one
 * row at a time, without disabling any trigger. Requires db/2026-10-31-semog-storage.sql applied; with
 * db/2026-11-01-semog-storage-liberacao.sql also CANCELLED envelopes and PENDING ones with no live enrollment of an
 * unsigned recipient become eligible (the database decides; the plan only reports it).
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
import { PrismaClient } from '@prisma/client';
import { createSemogS3PdfStore, semogS3SettingsFromEnv } from '../packages/lib/server-only/semog-signing/pdf-store-s3';
import type { SemogStoragePlanRow } from '../packages/lib/server-only/semog-signing/storage-migration';
import {
  backupSemogStorageRows,
  migrateSemogStorageRow,
  planSemogStorageMigration,
} from '../packages/lib/server-only/semog-signing/storage-migration';

const storeFromEnvironment = () => {
  const settings = semogS3SettingsFromEnv((name) => process.env[name]);
  if (!settings) {
    throw new Error('NEXT_PUBLIC_UPLOAD_TRANSPORT=s3 ausente: sem armazenamento de objetos para onde migrar.');
  }
  return createSemogS3PdfStore(settings);
};
const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
const printPlan = (plan: SemogStoragePlanRow[]) => {
  for (const row of plan) {
    const situacao = row.eligible ? 'ELEGÍVEL' : `fora: ${row.motivo}`;
    process.stdout.write(
      `${row.id}  ${mib(row.bytes)}  ${row.dataKey}  envelope=${row.envelopeId ?? '-'}  status=${row.status ?? '-'}${row.orfa ? ' (original órfão)' : ''}  ${situacao}\n`,
    );
  }
  const byStatus = new Map<string, { linhas: number; elegiveis: number; bytes: number }>();
  for (const row of plan) {
    const total = byStatus.get(row.status ?? '-') ?? { linhas: 0, elegiveis: 0, bytes: 0 };
    byStatus.set(row.status ?? '-', {
      linhas: total.linhas + 1,
      elegiveis: total.elegiveis + (row.eligible ? 1 : 0),
      bytes: total.bytes + (row.eligible ? row.bytes : 0),
    });
  }
  for (const [status, total] of byStatus) {
    process.stdout.write(`  ${status}: ${total.elegiveis} de ${total.linhas} elegíveis (${mib(total.bytes)})\n`);
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
// Entry point only (the logic lives in packages/lib): under vite-node, process.argv[1] is vite-node itself, so an
// "am I the main module" check never matched and the script exited 0 without doing anything.
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
