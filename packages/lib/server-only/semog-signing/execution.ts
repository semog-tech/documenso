import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { SemogJsonObject, SemogSnapshot } from './contract';
import { ZSemogEnvelopeSnapshotSource } from './contract';
import type { SemogExecutionOperation, SemogExecutionResult } from './execution-contract';
import { ZSemogExecutionOperation, ZSemogExecutionResult } from './execution-contract';
import type { SemogExternalEffects } from './execution-effects';
import { recordSemogExecutionEffects } from './execution-effects';
import type { SemogPreparedObserved } from './execution-observed';
import {
  bindSemogObserved,
  prepareSemogObserved,
  readSemogDocumentDataDigest,
  readSemogOutside,
  ZSemogSealReceipt,
} from './execution-observed';
import type { SemogPdfReader } from './initial-pdf';
import { inspectSemogPdf, validateSemogFieldGeometry } from './initial-pdf';
import { readSemogNativeEnvelope, readSemogNativeEnvelopeStructure } from './native-envelope';
import { applySemogNativeManifestation } from './native-mutations';
import type { SemogActor } from './service';
import { hashSemogManifestation, validateSemogFieldValues, ZSemogManifestation } from './service-validation';
import type { SemogDocumentHashes } from './snapshot';
import { buildSemogSnapshot, canonicalSemogJson, hashSemogDocument } from './snapshot';
import type { SemogStageObserver } from './timing';
import { timeSemogStage } from './timing';
import { validateSemogVisualSignature } from './visual';

export type SemogPrismaTransactionRunner = {
  $transaction: <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number; maxWait?: number },
  ) => Promise<T>;
};
type Dependencies = {
  enabled?: boolean;
  client: SemogPrismaTransactionRunner;
  readPdf: SemogPdfReader;
  observe?: SemogStageObserver;
  externalEffects?: SemogExternalEffects;
};
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
/**
 * A concluded signature, reported from the transaction's locked state. Its PDFs were read beforehand
 * (prepareSemogObserved); here only digests are compared, so no object or Base64 read happens under the lock.
 */
const observedResult = async (
  tx: Prisma.TransactionClient,
  operation: SemogExecutionOperation,
  prepared: SemogPreparedObserved,
) => {
  const result = replayResult(operation);
  if (result.acao !== 'assinar') {
    return { result, sealed: null };
  }
  const envelope = await tx.envelope.findFirst({
    where: { id: operation.envelopeId, teamId: operation.teamId, status: 'COMPLETED', completedAt: { not: null } },
    include: { envelopeItems: { include: { documentData: { select: { id: true } } } } },
  });
  if (!envelope) {
    return { result, sealed: null };
  }
  if (envelope.envelopeItems.length !== 1) {
    throw unavailable();
  }
  const data = envelope.envelopeItems[0].documentData;
  const seal = ZSemogSealReceipt.safeParse(operation.execucao?.selagem);
  if (!seal.success) {
    return { result, sealed: null };
  }
  if (seal.data.documentDataId !== data.id) {
    throw unavailable();
  }
  const digest = await readSemogDocumentDataDigest(tx, data.id);
  // The sealed file must be a new document, never the original under another name.
  if (digest.data === digest.initial) {
    throw unavailable();
  }
  const observed = bindSemogObserved(prepared, {
    documentDataId: data.id,
    digest,
    hashDocumento: operation.hashDocumento,
    hashPdf: seal.data.hashPdf,
  });
  // Sealed after the pre-read: honestly "not yet available"; the next query reads it.
  return observed === null
    ? { result, sealed: null }
    : { result: { ...result, documentoConcluido: true, pdfDisponivel: true }, sealed: observed.sealed };
};

/** Bytes the caller already read in this same request (the reservation's snapshot check). */
export type SemogPrefetchedDocument = { envelope: unknown; pdf: Uint8Array };
type VerifiedDocument = SemogDocumentHashes & { documentDataId: string; pages: number };
/** null: the operation was already concluded when read, so no PDF is needed. */
type PreparedDocument = { ok: true; value: VerifiedDocument } | { ok: false; error: unknown } | null;
/** Everything settled before the Serializable transaction: the PDFs read and how external effects are recorded. */
type Prepared = {
  document: PreparedDocument;
  observed: SemogPreparedObserved;
  externalEffects?: SemogExternalEffects;
};
const nothingObserved: SemogPreparedObserved = { ok: true, value: null };

const readPendingDocument = async (
  dependencies: Dependencies,
  actor: SemogActor,
  key: string,
): Promise<SemogPrefetchedDocument | null> => {
  const current = await readSemogOutside(dependencies.client, async (tx) => {
    z.string().uuid().parse(key);
    const rows = await tx.$queryRaw<{ envelopeId: string; estado: string }[]>(
      Prisma.sql`SELECT "envelopeId", estado FROM semog_bridge.operations WHERE "chaveOperacao"=${key}::uuid AND "teamId"=${actor.teamId}`,
    );
    if (rows.length !== 1) {
      throw new AppError(AppErrorCode.NOT_FOUND, { statusCode: 404 });
    }
    return rows[0].estado === 'concluida' ? null : readSemogNativeEnvelope(tx, rows[0].envelopeId, actor);
  });
  if (!current) {
    return null;
  }
  const data = current.envelope.envelopeItems[0].documentData;
  const pdf = await dependencies.readPdf({ documentDataId: data.id, type: data.type, data: data.initialData });
  return { envelope: current.source, pdf };
};
const verifyDocument = (dependencies: Dependencies, document: SemogPrefetchedDocument) =>
  timeSemogStage(
    dependencies.observe,
    'execute.pdf',
    async (): Promise<VerifiedDocument> => {
      const data = ZSemogEnvelopeSnapshotSource.parse(document.envelope).envelopeItems[0].documentData;
      // Size limit before the %PDF- header check, the order the in-transaction validation always had.
      const pages = await inspectSemogPdf(document.pdf);
      return { ...hashSemogDocument(document.pdf, data.initialData), documentDataId: data.id, pages };
    },
    () => ({ bytes: document.pdf.byteLength }),
  );
/**
 * Download, hash and full parse happen once, before the Serializable transaction and its row locks. Nothing read
 * here is trusted by itself: the transaction binds it to the locked envelope (see bindVerifiedDocument).
 */
const prepareDocument = async (
  dependencies: Dependencies,
  actor: SemogActor,
  key: string,
  prefetched?: SemogPrefetchedDocument,
): Promise<PreparedDocument> => {
  try {
    const document =
      prefetched ??
      (await timeSemogStage(
        dependencies.observe,
        'execute.read',
        () => readPendingDocument(dependencies, actor, key),
        (value) => ({ bytes: value?.pdf.byteLength }),
      ));
    return document === null ? null : { ok: true, value: await verifyDocument(dependencies, document) };
  } catch (error) {
    // Deferred, never dropped: the transaction rethrows it where its own PDF read used to fail, after the
    // lock/snapshot checks that precede it, so refusal codes and their order stay what they were.
    return { ok: false, error };
  }
};
/**
 * Under the envelope lock. What protects the signature is the returned pair: the INITIAL_DATA digest the database
 * computes now, plus the SHA-256 of the bytes read, both fed to the snapshot rebuild, which must reproduce the
 * enrollment. The explicit comparison below is only an earlier, clearer refusal of the same mismatch.
 */
const bindVerifiedDocument = (
  current: Awaited<ReturnType<typeof readSemogNativeEnvelopeStructure>>,
  document: PreparedDocument,
): SemogDocumentHashes => {
  if (document === null) {
    throw unavailable();
  }
  if (!document.ok) {
    throw document.error;
  }
  const verified = document.value;
  if (
    current.source.envelopeItems[0].documentData.id !== verified.documentDataId ||
    current.hashInitialData !== verified.hashInitialData
  ) {
    throw unavailable();
  }
  validateSemogFieldGeometry(verified.pages, current.source.fields);
  return { hashDocumento: verified.hashDocumento, hashInitialData: current.hashInitialData };
};

const executeLocked = async (tx: Prisma.TransactionClient, actor: SemogActor, key: string, prepared: Prepared) => {
  const { document } = prepared;
  const operation = await lockOperation(tx, actor, key);
  const input = validateDurableBinding(operation);
  await validateSemogVisualSignature(input);
  if (operation.estado === 'concluida') {
    return (await observedResult(tx, operation, prepared.observed)).result;
  }
  const snapshot = await readActiveSnapshot(tx, operation);
  if (typeof snapshot.conteudo.consentimento !== 'string') {
    throw unavailable();
  }
  const current = await readSemogNativeEnvelopeStructure(tx, operation.envelopeId, actor);
  const rebuilt = buildSemogSnapshot({
    teamId: actor.teamId,
    envelope: current.source,
    documento: bindVerifiedDocument(current, document),
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
  return finishExecution(tx, actor, operation, current.envelope, auditIds, {
    hashSnapshot: snapshot.hashSnapshot,
    externalEffects: prepared.externalEffects,
  });
};

const finishExecution = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  operation: SemogExecutionOperation,
  envelope: Awaited<ReturnType<typeof readSemogNativeEnvelopeStructure>>['envelope'],
  auditIds: string[],
  { hashSnapshot, externalEffects }: { hashSnapshot: string; externalEffects?: SemogExternalEffects },
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
    externalEffects,
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
/** Serializable conflicts and deadlocks are safe to retry: the losing transaction wrote nothing. */
export const isSemogRetryableTransactionError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  (error.code === 'P2034' || (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code))));
// A transaction timeout (P2028) stays out of the retry list on purpose: the 30 s budget already exceeds the
// caller's HTTP timeout, so a retry would only run after the caller gave up. The fix is keeping I/O out of it.
const executeWithRetry = (dependencies: Dependencies, actor: SemogActor, key: string, prepared: Prepared) => {
  let attempts = 0;
  const run = async () => {
    while (attempts < 3) {
      attempts++;
      try {
        return await dependencies.client.$transaction((tx) => executeLocked(tx, actor, key, prepared), {
          isolationLevel: 'Serializable',
          timeout: 30000,
          maxWait: 10000,
        });
      } catch (error) {
        if (attempts === 3 || !isSemogRetryableTransactionError(error)) {
          throw error;
        }
      }
    }
    throw unavailable();
  };
  return timeSemogStage(dependencies.observe, 'execute.transaction', run, () => ({ attempts }));
};

/** Actual field/signature/recipient/audit writes. A failed callback rolls back ALL writes and outbox rows. */
export const createSemogPrismaExecutor = (dependencies: Dependencies) => {
  const observe = (actor: SemogActor, key: string) =>
    prepareSemogObserved(dependencies.client, dependencies.readPdf, actor, key);
  const readLocked = (actor: SemogActor, key: string, prepared: SemogPreparedObserved) =>
    dependencies.client.$transaction(
      async (tx) => {
        const operation = await lockOperation(tx, actor, key);
        validateDurableBinding(operation);
        if (operation.estado !== 'concluida') {
          return {
            result: ZSemogExecutionResult.parse({ ...confirmedResult(operation), situacao: 'pendente' }),
            sealed: null,
          };
        }
        return await observedResult(tx, operation, prepared);
      },
      { isolationLevel: 'Serializable', timeout: 10000, maxWait: 10000 },
    );
  return {
    /** Without `prefetched` (replay of a reserved key) the executor reads the PDF itself, still outside the transaction. */
    execute: async (actor: SemogActor, key: string, prefetched?: SemogPrefetchedDocument) => {
      requireEnabled(dependencies);
      const document = await prepareDocument(dependencies, actor, key, prefetched);
      // A key already concluded when read needs its sealed PDF instead, also read before the transaction.
      const observed = document === null ? await observe(actor, key) : nothingObserved;
      return await executeWithRetry(dependencies, actor, key, {
        document,
        observed,
        externalEffects: dependencies.externalEffects,
      });
    },
    get: async (actor: SemogActor, key: string): Promise<SemogExecutionResult> => {
      requireEnabled(dependencies);
      return (await readLocked(actor, key, await observe(actor, key))).result;
    },
    pdf: async (actor: SemogActor, key: string) => {
      requireEnabled(dependencies);
      const { result, sealed } = await readLocked(actor, key, await observe(actor, key));
      if (!result.pdfDisponivel || sealed === null) {
        throw unavailable();
      }
      // The very bytes whose SHA-256 the locked receipt just confirmed.
      return sealed;
    },
  };
};
