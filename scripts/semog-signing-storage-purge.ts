/**
 * Purge on demand of the R2 objects of CANCELLED bridge envelopes. Requires db/2026-11-01-semog-storage-liberacao.sql.
 * The database decides what may go and keeps the permanent record (semog_bridge.storage_purges); never a DocumentData
 * row is changed by the purge itself (an inline PDF of the envelope is first moved to R2 by the storage migration).
 *
 *   Simulação (padrão, não grava nada) — o mesmo que a varredura diária faria agora:
 *     node24 node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts \
 *       scripts/semog-signing-storage-purge.ts
 *   Um envelope CANCELLED já, ignorando a retenção (só para ele):
 *     ... scripts/semog-signing-storage-purge.ts --envelope <id> --agora --motivo "Ata de teste" [--aplicar]
 *   Se o PDF dele ainda estava inline, a migração acabou de gravar o objeto e a carência (24 h) o adiaria; para
 *   esse caso, e só com --agora: --carencia-horas 0.
 *
 * Environment: NEXT_PRIVATE_DATABASE_URL, NEXT_PUBLIC_UPLOAD_TRANSPORT=s3 and NEXT_PRIVATE_UPLOAD_* (the Documenso
 * container's), SEMOG_CANCELLED_RETENTION_DAYS (90) and SEMOG_STORAGE_PURGE_GRACE_HOURS (24).
 */
import { userInfo } from 'node:os';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  createSemogS3PurgeObjects,
  semogS3SettingsFromEnv,
} from '../packages/lib/server-only/semog-signing/pdf-store-s3';
import {
  migrateSemogCancelledInline,
  planSemogStorageMigration,
} from '../packages/lib/server-only/semog-signing/storage-migration';
import type { SemogPurgeObjects, SemogPurgeOutcome } from '../packages/lib/server-only/semog-signing/storage-purge';
import {
  createSemogPurgeLedger,
  readSemogPurgeSettings,
  runSemogStoragePurge,
} from '../packages/lib/server-only/semog-signing/storage-purge';

type Arguments = {
  envelope: string | null;
  motivo: string | undefined;
  apply: boolean;
  quem: string;
  /** --carencia-horas, only with --agora: the freshly migrated object of the named envelope is expected. */
  graceHours: number | undefined;
};
const flagValue = (argv: string[], flag: string) => {
  const at = argv.indexOf(flag);
  if (at < 0) {
    return undefined;
  }
  const value = argv[at + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} exige um valor logo em seguida.`);
  }
  return value;
};
const graceFlag = (argv: string[], immediate: boolean) => {
  const raw = flagValue(argv, '--carencia-horas');
  if (raw !== undefined && (!immediate || !/^[0-9]+$/.test(raw))) {
    throw new Error('--carencia-horas aceita um inteiro >= 0, e só junto de --agora.');
  }
  return raw === undefined ? undefined : Number(raw);
};
const parseSemogPurgeArguments = (argv: string[]): Arguments => {
  const envelope = flagValue(argv, '--envelope') ?? null;
  const now = argv.includes('--agora');
  if ((envelope === null) !== !now) {
    throw new Error('--envelope e --agora andam juntos: a purga imediata é sempre de um envelope nomeado.');
  }
  const motivo = flagValue(argv, '--motivo');
  if (envelope !== null && !motivo?.trim()) {
    throw new Error('--agora exige --motivo "<texto>" (fica no registro permanente).');
  }
  return {
    envelope,
    motivo,
    apply: argv.includes('--aplicar'),
    quem: flagValue(argv, '--quem') ?? `cli:${userInfo().username}`,
    graceHours: graceFlag(argv, now),
  };
};

const requireMigration = async (client: PrismaClient) => {
  const rows = await client.$queryRaw<{ ready: boolean }[]>(
    Prisma.sql`SELECT to_regprocedure('semog_bridge.storage_purge_begin(text,integer,text,text,text)') IS NOT NULL ready`,
  );
  if (rows[0]?.ready !== true) {
    throw new Error('Migração db/2026-11-01-semog-storage-liberacao.sql ausente: nada foi lido nem alterado.');
  }
};
const describeEnvelope = async (client: PrismaClient, envelopeId: string) => {
  const rows = await client.$queryRaw<{ status: string; ponte: boolean; canceladoEm: Date | null }[]>(Prisma.sql`
    SELECT status::text status, semog_bridge.storage_is_bridge_envelope(id) ponte, "completedAt" "canceladoEm"
    FROM public."Envelope" WHERE id=${envelopeId}`);
  const row = rows[0];
  if (!row || row.status !== 'CANCELLED' || !row.ponte) {
    throw new Error(`Envelope ${envelopeId} não é um envelope CANCELLED da ponte (${row?.status ?? 'inexistente'}).`);
  }
  process.stdout.write(`Envelope ${envelopeId}: CANCELLED em ${row.canceladoEm?.toISOString() ?? '?'}\n`);
};
const printOutcomes = (outcomes: SemogPurgeOutcome[]) => {
  for (const item of outcomes) {
    process.stdout.write(
      `${item.resultado.padEnd(10)} ${item.chave}  envelopes=${item.envelopes.join(',') || '-'}${item.detalhe ? `  ${item.detalhe}` : ''}\n`,
    );
  }
  process.stdout.write(`${outcomes.length} chave(s).\n`);
};
const objectsFromEnvironment = () => {
  const settings = semogS3SettingsFromEnv((name) => process.env[name]);
  if (!settings) {
    throw new Error('NEXT_PUBLIC_UPLOAD_TRANSPORT=s3 ausente: não há armazenamento de objetos para purgar.');
  }
  return createSemogS3PurgeObjects(settings);
};
/** An inline PDF of a cancelled envelope goes to R2 first (only with --aplicar); the dry run just counts it. */
const migrateInlineFirst = async (client: PrismaClient, objects: SemogPurgeObjects, args: Arguments) => {
  const inline = (await planSemogStorageMigration(client)).filter(
    (row) => row.eligible && row.status === 'CANCELLED' && (args.envelope === null || row.envelopeId === args.envelope),
  );
  if (inline.length === 0) {
    return;
  }
  if (!args.apply) {
    process.stdout.write(`${inline.length} linha(s) inline seriam migradas para o R2 antes da purga.\n`);
    return;
  }
  const moved = await migrateSemogCancelledInline(client, objects, args.envelope);
  process.stdout.write(`Migradas para o R2 antes da purga: ${moved.join(', ')}\n`);
};
const purge = async (client: PrismaClient, objects: SemogPurgeObjects, args: Arguments) => {
  const settings = readSemogPurgeSettings((name) => process.env[name]);
  return await runSemogStoragePurge(
    { ledger: createSemogPurgeLedger(client), objects },
    {
      retentionDays: settings.retentionDays,
      graceHours: args.graceHours ?? settings.graceHours,
      immediateEnvelopeId: args.envelope,
      motivo: args.motivo,
      quem: args.quem,
      apply: args.apply,
    },
  );
};
const main = async () => {
  const args = parseSemogPurgeArguments(process.argv.slice(2));
  const client = new PrismaClient({ datasourceUrl: process.env.NEXT_PRIVATE_DATABASE_URL });
  try {
    await requireMigration(client);
    if (args.envelope !== null) {
      await describeEnvelope(client, args.envelope);
    }
    const objects = objectsFromEnvironment();
    await migrateInlineFirst(client, objects, args);
    const outcomes = await purge(client, objects, args);
    printOutcomes(outcomes);
    if (!args.apply) {
      process.stdout.write('Simulação: nada foi alterado. Use --aplicar para executar.\n');
    }
    if (outcomes.some((item) => item.resultado === 'erro' || item.resultado === 'conflito')) {
      process.exitCode = 1;
    }
  } finally {
    await client.$disconnect();
  }
};
// Entry point only: under vite-node process.argv[1] is vite-node itself, so no "am I main" check (see the migration).
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
