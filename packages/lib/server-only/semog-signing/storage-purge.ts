import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import type { SemogPdfStore } from './pdf-store';
import { readSemogStoredPdf, semogPdfKeyHash } from './pdf-store';

/**
 * Purge of the R2 objects of CANCELLED bridge envelopes after the retention (db/2026-11-01-semog-storage-liberacao).
 * The database decides what may go (storage_purge_candidates / _begin) and keeps the permanent record; this module
 * only moves objects, in an order where a crash never leaves a lying record nor an untracked removal:
 *   begin (intent 'pendente') -> grace check -> read and prove the bytes -> remove -> conflicts? -> finish/abandon.
 * A 'pendente' row left behind is resumed by the next run (begin returns it, re-judged by its own terms).
 */
type SqlClient = Pick<Prisma.TransactionClient, '$queryRaw'>;
export type SemogPurgeCandidate = { chave: string; envelopes: string[]; canceladoEm: Date | null };
export type SemogPurgeRecord = {
  id: string;
  chave: string;
  envelopes: string[];
  estado: 'pendente' | 'purgada' | 'desistida';
  purgavel?: boolean;
};
export type SemogPurgeLedger = {
  candidates: (retentionDays: number, immediate: string | null) => Promise<SemogPurgeCandidate[]>;
  pendingKeys: () => Promise<string[]>;
  begin: (input: {
    chave: string;
    retentionDays: number;
    immediate: string | null;
    motivo: string;
    quem: string;
  }) => Promise<SemogPurgeRecord>;
  conflicts: (id: string) => Promise<string[]>;
  finish: (id: string, absent: boolean) => Promise<SemogPurgeRecord>;
  abandon: (id: string, observacao: string) => Promise<SemogPurgeRecord>;
};
/** The bridge store plus the two calls only the purge needs. `lastModified` is null when the object is absent. */
export type SemogPurgeObjects = SemogPdfStore & {
  lastModified: (key: string) => Promise<Date | null>;
  remove: (key: string) => Promise<void>;
};
export type SemogPurgeOptions = {
  retentionDays: number;
  graceHours: number;
  /** CLI --agora: only this CANCELLED envelope, ignoring the retention for it. */
  immediateEnvelopeId: string | null;
  motivo?: string;
  quem: string;
  apply: boolean;
  now?: () => Date;
};
export type SemogPurgeResult =
  | 'simulada'
  | 'purgada'
  | 'ausente'
  | 'adiada'
  | 'desistida'
  /** The object does not hash to its key: corruption, kept and reported, never removed. */
  | 'divergente'
  | 'restaurada'
  | 'conflito'
  | 'ignorada'
  | 'erro';
export type SemogPurgeOutcome = { chave: string; envelopes: string[]; resultado: SemogPurgeResult; detalhe?: string };

const ZRecord = z.object({
  id: z.string().uuid(),
  chave: z.string(),
  envelopes: z.array(z.string()),
  estado: z.enum(['pendente', 'purgada', 'desistida']),
  purgavel: z.boolean().optional(),
});
const ZCandidate = z.object({ chave: z.string(), envelopes: z.array(z.string()), canceladoEm: z.date().nullable() });
const one = async (rows: Promise<{ result: unknown }[]>) => ZRecord.parse((await rows)[0]?.result);

export const createSemogPurgeLedger = (client: SqlClient): SemogPurgeLedger => ({
  candidates: async (retentionDays, immediate) =>
    z.array(ZCandidate).parse(
      await client.$queryRaw(Prisma.sql`SELECT chave, envelopes, "canceladoEm"
        FROM semog_bridge.storage_purge_candidates(${retentionDays}::integer, ${immediate}::text) ORDER BY chave`),
    ),
  pendingKeys: async () =>
    z
      .array(z.object({ chave: z.string() }))
      .parse(
        await client.$queryRaw(
          Prisma.sql`SELECT chave FROM semog_bridge.storage_purges WHERE estado='pendente' ORDER BY chave`,
        ),
      )
      .map((row) => row.chave),
  begin: ({ chave, retentionDays, immediate, motivo, quem }) =>
    one(
      client.$queryRaw(Prisma.sql`SELECT semog_bridge.storage_purge_begin(${chave}, ${retentionDays}::integer,
        ${immediate}::text, ${motivo}, ${quem}) result`),
    ),
  conflicts: async (id) => {
    const rows = await client.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT d.id FROM semog_bridge.storage_purges p
      JOIN public."DocumentData" d ON d.type='S3_PATH' AND (d.data=p.chave OR d."initialData"=p.chave)
      WHERE p.id=${id}::uuid AND NOT semog_bridge.storage_purgeable_context(d.id,p."retencaoDias",p."envelopeImediato")
      ORDER BY d.id`);
    return z
      .array(z.object({ id: z.string() }))
      .parse(rows)
      .map((row) => row.id);
  },
  finish: (id, absent) =>
    one(client.$queryRaw(Prisma.sql`SELECT semog_bridge.storage_purge_finish(${id}::uuid, ${absent}) result`)),
  abandon: (id, observacao) =>
    one(client.$queryRaw(Prisma.sql`SELECT semog_bridge.storage_purge_abandon(${id}::uuid, ${observacao}) result`)),
});

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const positiveInteger = (raw: string | undefined, fallback: number, name: string) => {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!POSITIVE_INTEGER.test(raw)) {
    throw new Error(`${name} deve ser um inteiro positivo (recebido: ${raw}).`);
  }
  return Number(raw);
};
/** SEMOG_CANCELLED_RETENTION_DAYS (default 90) and SEMOG_STORAGE_PURGE_GRACE_HOURS (default 24). */
export const readSemogPurgeSettings = (read: (name: string) => string | undefined) => ({
  retentionDays: positiveInteger(read('SEMOG_CANCELLED_RETENTION_DAYS'), 90, 'SEMOG_CANCELLED_RETENTION_DAYS'),
  graceHours: positiveInteger(read('SEMOG_STORAGE_PURGE_GRACE_HOURS'), 24, 'SEMOG_STORAGE_PURGE_GRACE_HOURS'),
});

type Deps = { ledger: SemogPurgeLedger; objects: SemogPurgeObjects };
type Step = { deps: Deps; record: SemogPurgeRecord };
const outcome = (record: SemogPurgeRecord, resultado: SemogPurgeResult, detalhe?: string): SemogPurgeOutcome => ({
  chave: record.chave,
  envelopes: record.envelopes,
  resultado,
  ...(detalhe === undefined ? {} : { detalhe }),
});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The object went while a new row started pointing at its key: put the very same bytes back, or say it failed. */
const restoreOrRecord = async ({ deps, record }: Step, bytes: Uint8Array, conflicts: string[]) => {
  try {
    await deps.objects.write(record.chave, bytes);
    await readSemogStoredPdf(deps.objects, record.chave);
    await deps.ledger.abandon(record.id, `restaurado: referência nova em ${conflicts.join(',')}`.slice(0, 500));
    return outcome(record, 'restaurada', conflicts.join(','));
  } catch (error) {
    await deps.ledger.finish(record.id, false);
    return outcome(record, 'conflito', `${conflicts.join(',')}; restauração falhou: ${message(error)}`);
  }
};
const removeProven = async (step: Step) => {
  const { deps, record } = step;
  // A read failure (network, timeout) propagates: the intent stays 'pendente' and the next run resumes it. Only bytes
  // that really hash to something else close it for good — that is corruption, not a hiccup.
  const bytes = await deps.objects.read(record.chave);
  const found = createHash('sha256').update(bytes).digest('hex');
  if (found !== semogPdfKeyHash(record.chave)) {
    await deps.ledger.abandon(record.id, `SHA-256 divergente: o objeto tem ${found}; nada foi apagado`);
    return outcome(record, 'divergente', `SHA-256 divergente (${found})`);
  }
  await deps.objects.remove(record.chave);
  const conflicts = await deps.ledger.conflicts(record.id);
  if (conflicts.length > 0) {
    return await restoreOrRecord(step, bytes, conflicts);
  }
  await deps.ledger.finish(record.id, false);
  return outcome(record, 'purgada');
};
const settle = async (step: Step): Promise<SemogPurgeOutcome> => {
  const { deps, record } = step;
  const modified = await deps.objects.lastModified(record.chave);
  if (modified === null) {
    await deps.ledger.finish(record.id, true);
    return outcome(record, 'ausente');
  }
  if (record.purgavel === false) {
    await deps.ledger.abandon(record.id, 'chave deixou de ser purgável antes da remoção');
    return outcome(record, 'desistida', 'chave deixou de ser purgável');
  }
  return await removeProven(step);
};
/** Checked BEFORE any intent is recorded: a deferral leaves no row in the permanent ledger, the next run retries. */
const recentlyWritten = async (deps: Deps, options: SemogPurgeOptions, chave: string) => {
  const modified = await deps.objects.lastModified(chave);
  const now = (options.now ?? (() => new Date()))();
  return modified !== null && now.getTime() - modified.getTime() < options.graceHours * 3_600_000 ? modified : null;
};

const motivoFor = (options: SemogPurgeOptions) =>
  options.motivo ?? `Retenção de ${options.retentionDays} dias após o cancelamento`;
const purgeKey = async (
  deps: Deps,
  options: SemogPurgeOptions,
  candidate: SemogPurgeCandidate,
): Promise<SemogPurgeOutcome> => {
  let record: SemogPurgeRecord;
  try {
    const recent = await recentlyWritten(deps, options, candidate.chave);
    if (recent !== null) {
      const detalhe = `carência: gravado em ${recent.toISOString()}`;
      return { chave: candidate.chave, envelopes: candidate.envelopes, resultado: 'adiada', detalhe };
    }
    record = await deps.ledger.begin({
      chave: candidate.chave,
      retentionDays: options.retentionDays,
      immediate: options.immediateEnvelopeId,
      motivo: motivoFor(options),
      quem: options.quem,
    });
  } catch (error) {
    // Only the database's own refusal means "no longer a candidate"; anything else is a failure, said as such.
    const resultado = /is not purgeable/.test(message(error)) ? 'ignorada' : 'erro';
    return { chave: candidate.chave, envelopes: candidate.envelopes, resultado, detalhe: message(error) };
  }
  try {
    return await settle({ deps, record });
  } catch (error) {
    // The intent stays 'pendente': the next run resumes it; nothing claims a removal that may not have happened.
    return outcome(record, 'erro', message(error));
  }
};

const validate = (options: SemogPurgeOptions) => {
  if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1) {
    throw new Error('Retenção deve ser de pelo menos 1 dia.');
  }
  if (options.immediateEnvelopeId !== null && !options.motivo?.trim()) {
    throw new Error('Purga imediata exige motivo.');
  }
  // Zero only for a named envelope purged on purpose: there the fresh object is the one the migration just wrote.
  const minimumGrace = options.immediateEnvelopeId === null ? 1 : 0;
  if (!Number.isSafeInteger(options.graceHours) || options.graceHours < minimumGrace) {
    throw new Error(`Carência deve ser de pelo menos ${minimumGrace} hora(s).`);
  }
};
/** Pending intents first (resume), then the current candidates. Sequential: one object in memory at a time. */
export const runSemogStoragePurge = async (deps: Deps, options: SemogPurgeOptions): Promise<SemogPurgeOutcome[]> => {
  validate(options);
  const candidates = await deps.ledger.candidates(options.retentionDays, options.immediateEnvelopeId);
  if (!options.apply) {
    return candidates.map(({ chave, envelopes }) => ({ chave, envelopes, resultado: 'simulada' as const }));
  }
  const pending = options.immediateEnvelopeId === null ? await deps.ledger.pendingKeys() : [];
  const queue = [
    ...pending.map((chave) => ({ chave, envelopes: [], canceladoEm: null })),
    ...candidates.filter((candidate) => !pending.includes(candidate.chave)),
  ];
  const outcomes: SemogPurgeOutcome[] = [];
  for (const candidate of queue) {
    outcomes.push(await purgeKey(deps, options, candidate));
  }
  return outcomes;
};
