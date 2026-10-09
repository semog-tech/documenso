import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { SemogJsonObject, SemogSnapshot } from './contract';
import type { SemogExecutionOperation, SemogExecutionResult } from './execution-contract';
import { ZSemogExecutionOperation, ZSemogExecutionResult } from './execution-contract';
import { recordSemogExecutionEffects } from './execution-effects';
import type { SemogPdfReader } from './initial-pdf';
import { validateSemogPdf } from './initial-pdf';
import { readSemogNativeEnvelope } from './native-envelope';
import { applySemogNativeManifestation } from './native-mutations';
import type { SemogActor } from './service';
import { hashSemogManifestation, validateSemogFieldValues, ZSemogManifestation } from './service-validation';
import { buildSemogSnapshot, canonicalSemogJson } from './snapshot';
import { validateSemogVisualSignature } from './visual';

export type SemogPrismaTransactionRunner = {
  $transaction: <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number; maxWait?: number },
  ) => Promise<T>;
};
type Dependencies = { enabled?: boolean; client: SemogPrismaTransactionRunner; readPdf: SemogPdfReader };
const unavailable = () => new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
const requireEnabled = (dependencies: Dependencies) => {
  if (dependencies.enabled !== true) {
    throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
  }
};
const snapshotSchema = z.object({
  id: z.string().uuid(),
  teamId: z.number().int(),
  envelopeId: z.string(),
  recipientId: z.number().int(),
  hashDocumento: z.string(),
  hashConsentimento: z.string(),
  hashSnapshot: z.string(),
  expiraEm: z.string(),
  conteudo: z.record(z.unknown()),
  revogadaEm: z.string().nullable(),
});

const lockOperation = async (tx: Prisma.TransactionClient, actor: SemogActor, key: string) => {
  z.string().uuid().parse(key);
  const lookup = await tx.$queryRaw<{ envelopeId: string }[]>(
    Prisma.sql`SELECT "envelopeId" FROM semog_bridge.operations WHERE "chaveOperacao"=${key}::uuid AND "teamId"=${actor.teamId}`,
  );
  if (lookup.length !== 1) {
    throw new AppError(AppErrorCode.NOT_FOUND, { statusCode: 404 });
  }
  const locked = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM public."Envelope" WHERE id=${lookup[0].envelopeId} AND "teamId"=${actor.teamId} FOR UPDATE`,
  );
  if (locked.length !== 1) {
    throw unavailable();
  }
  const rows = await tx.$queryRaw<{ body: unknown }[]>(
    Prisma.sql`SELECT to_jsonb(o) body FROM semog_bridge.operations o WHERE "chaveOperacao"=${key}::uuid AND "teamId"=${actor.teamId} FOR UPDATE`,
  );
  return ZSemogExecutionOperation.parse(rows[0]?.body);
};
const readActiveSnapshot = async (
  tx: Prisma.TransactionClient,
  operation: SemogExecutionOperation,
): Promise<SemogSnapshot> => {
  const rows = await tx.$queryRaw<
    { body: unknown; active: boolean }[]
  >(Prisma.sql`SELECT to_jsonb(s) body, (s."revogadaEm" IS NULL AND s."expiraEm">clock_timestamp()) active
    FROM semog_bridge.snapshots s WHERE id=${operation.snapshotId}::uuid AND "teamId"=${operation.teamId} FOR UPDATE`);
  if (rows.length !== 1 || rows[0].active !== true) {
    throw unavailable();
  }
  const snapshot = snapshotSchema.parse(rows[0].body);
  const content = canonicalSemogJson(snapshot.conteudo);
  if (content === null || Array.isArray(content) || typeof content !== 'object') {
    throw unavailable();
  }
  return { ...snapshot, conteudo: content };
};

const confirmedResult = (operation: SemogExecutionOperation): SemogExecutionResult => ({
  chaveOperacao: operation.chaveOperacao,
  envelopeId: operation.envelopeId,
  recipientId: operation.recipientId,
  hashDocumento: operation.hashDocumento,
  hashConsentimento: operation.hashConsentimento,
  acao: ZSemogManifestation.parse(operation.pedido).acao,
  situacao: 'concluida',
  documentoConcluido: false,
  pdfDisponivel: false,
});
const validateDurableBinding = (operation: SemogExecutionOperation) => {
  const input = ZSemogManifestation.parse(operation.pedido);
  if (
    input.chaveOperacao !== operation.chaveOperacao ||
    input.envelopeId !== operation.envelopeId ||
    input.recipientId !== operation.recipientId ||
    input.acao !== operation.acao ||
    input.hashDocumento !== operation.hashDocumento ||
    input.hashConsentimento !== operation.hashConsentimento ||
    hashSemogManifestation(input) !== operation.hashPedido
  ) {
    throw unavailable();
  }
  return input;
};
const replayResult = (operation: SemogExecutionOperation) => {
  const result = ZSemogExecutionResult.parse(operation.resultado);
  const expected = confirmedResult(operation);
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    // Persisted results are canonical output, never inferred from an unrelated native signing status.
    throw unavailable();
  }
  return result;
};
const observedResult = async (
  dependencies: Dependencies,
  tx: Prisma.TransactionClient,
  operation: SemogExecutionOperation,
) => {
  const result = replayResult(operation);
  if (result.acao !== 'assinar') {
    return result;
  }
  const envelope = await tx.envelope.findFirst({
    where: { id: operation.envelopeId, teamId: operation.teamId, status: 'COMPLETED', completedAt: { not: null } },
    include: { envelopeItems: { include: { documentData: true } } },
  });
  if (!envelope) {
    return result;
  }
  if (envelope.envelopeItems.length !== 1) {
    throw unavailable();
  }
  const data = envelope.envelopeItems[0].documentData;
  const seal = z
    .object({ documentDataId: z.string(), hashPdf: z.string().regex(/^[a-f0-9]{64}$/) })
    .safeParse(operation.execucao?.selagem);
  if (!seal.success) {
    return result;
  }
  if (seal.data.documentDataId !== data.id) {
    throw unavailable();
  }
  const original = await dependencies.readPdf({ documentDataId: data.id, type: data.type, data: data.initialData });
  if (
    createHash('sha256').update(original).digest('hex') !== operation.hashDocumento ||
    data.data === data.initialData
  ) {
    throw unavailable();
  }
  const pdf = await dependencies.readPdf({ documentDataId: data.id, type: data.type, data: data.data });
  if (createHash('sha256').update(pdf).digest('hex') !== seal.data.hashPdf) {
    throw unavailable();
  }
  await validateSemogPdf(pdf, []);
  const contents = Buffer.from(pdf).toString('latin1');
  if (!contents.includes('/ByteRange') || !contents.includes('/ETSI.CAdES.detached')) {
    throw unavailable();
  }
  return { ...result, documentoConcluido: true, pdfDisponivel: true };
};

const executeLocked = async (
  dependencies: Dependencies,
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  key: string,
) => {
  const operation = await lockOperation(tx, actor, key);
  const input = validateDurableBinding(operation);
  await validateSemogVisualSignature(input);
  if (operation.estado === 'concluida') {
    return observedResult(dependencies, tx, operation);
  }
  const snapshot = await readActiveSnapshot(tx, operation);
  if (typeof snapshot.conteudo.consentimento !== 'string') {
    throw unavailable();
  }
  const current = await readSemogNativeEnvelope(tx, operation.envelopeId, actor);
  const data = current.envelope.envelopeItems[0].documentData;
  const pdf = await dependencies.readPdf({ documentDataId: data.id, type: data.type, data: data.initialData });
  await validateSemogPdf(pdf, current.source.fields);
  const rebuilt = buildSemogSnapshot({
    teamId: actor.teamId,
    envelope: current.source,
    pdf,
    recipientId: operation.recipientId,
    consentimento: snapshot.conteudo.consentimento,
    expiraEm: snapshot.expiraEm,
  });
  if (
    rebuilt.hashSnapshot !== snapshot.hashSnapshot ||
    rebuilt.hashDocumento !== operation.hashDocumento ||
    rebuilt.hashConsentimento !== operation.hashConsentimento
  ) {
    throw unavailable();
  }
  validateSemogFieldValues(current.source, input);
  const recipient = current.source.recipients.find((candidate) => candidate.id === operation.recipientId);
  if (!recipient) {
    throw unavailable();
  }
  await tx.$queryRaw(Prisma.sql`SELECT set_config('semog_bridge.execution_key',${key},true)`);
  const auditIds = await applySemogNativeManifestation(tx, current.envelope, input, recipient);
  return finishExecution(tx, actor, operation, current.envelope, auditIds, snapshot.hashSnapshot);
};

const finishExecution = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  operation: SemogExecutionOperation,
  envelope: Awaited<ReturnType<typeof readSemogNativeEnvelope>>['envelope'],
  auditIds: string[],
  hashSnapshot: string,
) => {
  const input = ZSemogManifestation.parse(operation.pedido);
  const pending = await tx.recipient.findMany({
    where: { envelopeId: operation.envelopeId, role: { not: 'CC' }, signingStatus: { not: 'SIGNED' } },
    select: { id: true, signingOrder: true },
    orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  });
  await recordSemogExecutionEffects(tx, {
    envelopeId: operation.envelopeId,
    secondaryId: envelope.secondaryId,
    ownerUserId: envelope.userId,
    input,
    pending,
    sequential: envelope.documentMeta.signingOrder === 'SEQUENTIAL',
  });
  const result = confirmedResult(operation);
  const receipt: SemogJsonObject = {
    actorUserId: actor.userId,
    teamId: actor.teamId,
    snapshotId: operation.snapshotId,
    hashSnapshot,
    hashDocumento: operation.hashDocumento,
    auditIds,
    executionVersion: 1,
  };
  await tx.$executeRaw(
    Prisma.sql`UPDATE semog_bridge.operations SET execucao=${JSON.stringify(receipt)}::jsonb WHERE "chaveOperacao"=${operation.chaveOperacao}::uuid AND estado='pendente'`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT public.semog_signing_finish_operation(${actor.teamId}::integer,${operation.chaveOperacao}::uuid,${JSON.stringify(result)}::jsonb)`,
  );
  return result;
};
const executeWithRetry = async (dependencies: Dependencies, actor: SemogActor, key: string) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await dependencies.client.$transaction((tx) => executeLocked(dependencies, tx, actor, key), {
        isolationLevel: 'Serializable',
        timeout: 30000,
        maxWait: 10000,
      });
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code))));
      if (attempt === 2 || !retryable) {
        throw error;
      }
    }
  }
  throw unavailable();
};

/** Actual field/signature/recipient/audit writes. A failed callback rolls back ALL writes and outbox rows. */
export const createSemogPrismaExecutor = (dependencies: Dependencies) => ({
  execute: async (actor: SemogActor, key: string) => {
    requireEnabled(dependencies);
    return await executeWithRetry(dependencies, actor, key);
  },
  get: async (actor: SemogActor, key: string): Promise<SemogExecutionResult> => {
    requireEnabled(dependencies);
    return await dependencies.client.$transaction(
      async (tx) => {
        const operation = await lockOperation(tx, actor, key);
        validateDurableBinding(operation);
        if (operation.estado === 'concluida') {
          return observedResult(dependencies, tx, operation);
        }
        return ZSemogExecutionResult.parse({ ...confirmedResult(operation), situacao: 'pendente' });
      },
      { isolationLevel: 'Serializable', timeout: 10000 },
    );
  },
  pdf: async (actor: SemogActor, key: string) => {
    requireEnabled(dependencies);
    return await dependencies.client.$transaction(
      async (tx) => {
        const operation = await lockOperation(tx, actor, key);
        validateDurableBinding(operation);
        if (operation.estado !== 'concluida' || !(await observedResult(dependencies, tx, operation)).pdfDisponivel) {
          throw unavailable();
        }
        const item = await tx.envelopeItem.findFirstOrThrow({
          where: { envelopeId: operation.envelopeId },
          include: { documentData: true },
        });
        return dependencies.readPdf({
          documentDataId: item.documentData.id,
          type: item.documentData.type,
          data: item.documentData.data,
        });
      },
      { isolationLevel: 'Serializable', timeout: 30000 },
    );
  },
});
