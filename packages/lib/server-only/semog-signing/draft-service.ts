import { Prisma } from '@prisma/client';
import { AppErrorCode } from '../../errors/app-error';
import { createSemogNativeDraft } from './draft-native';
import { lockSemogDraft, replaySemogDraft, saveSemogDraftReceipt } from './draft-repository';
import { semogDraftMaximum, validateSemogBinaryDraft, validateSemogDraft } from './draft-validation';
import type { SemogPrismaTransactionRunner } from './execution';
import type { SemogPdfStore, SemogStoredPdf } from './pdf-store';
import { ensureSemogStoredPdf, putSemogStoredPdf } from './pdf-store';
import type { SemogActor } from './service';
import { semogError } from './service-validation';
import { type SemogStageObserver, timeSemogStage } from './timing';

type Dependencies = {
  observe?: SemogStageObserver;
  enabled?: boolean;
  client: SemogPrismaTransactionRunner;
  authenticate: (token: string) => Promise<SemogActor | null>;
  maximumPdfBytes?: number;
  pdfStore?: SemogPdfStore;
};
const assertActor = async (tx: Prisma.TransactionClient, actor: SemogActor) => {
  const user = await tx.user.findFirst({ where: { id: actor.userId, disabled: false }, select: { id: true } });
  const team = await tx.team.findFirst({
    where: { id: actor.teamId, organisation: { owner: { disabled: false } } },
    select: { id: true },
  });
  if (!user || !team) {
    throw semogError(AppErrorCode.UNAUTHORIZED, 401);
  }
};
export const createSemogDraftService = (dependencies: Dependencies) => {
  const observe = dependencies.observe;
  const store = dependencies.pdfStore;
  const exists = store?.exists;
  // Preserve method receivers and HEAD availability; these stages include the store's own integrity work.
  const measuredStore: SemogPdfStore | undefined = store && {
    write: (key, bytes) =>
      timeSemogStage(
        observe,
        'draft.storage.write',
        async () => {
          await store.write(key, bytes);
          return bytes;
        },
        (value) => ({ bytes: value.byteLength }),
      ).then(() => undefined),
    read: (key) =>
      timeSemogStage(
        observe,
        'draft.storage.read',
        () => store.read(key),
        (bytes) => ({ bytes: bytes.byteLength }),
      ),
    ...(exists
      ? { exists: (key: string) => timeSemogStage(observe, 'draft.storage.head', () => exists.call(store, key)) }
      : {}),
  };
  const maximumPdfBytes = semogDraftMaximum(dependencies.maximumPdfBytes);
  const requireEnabled = () => {
    if (dependencies.enabled !== true) {
      throw semogError(AppErrorCode.NOT_SETUP, 503);
    }
  };
  const authenticate = async (token: string) => {
    requireEnabled();
    const actor = await dependencies.authenticate(token);
    if (!actor) {
      throw semogError(AppErrorCode.UNAUTHORIZED, 401);
    }
    return actor;
  };
  /**
   * The object is uploaded before the transaction, under its content address: a retry rewrites the same key, and a
   * transaction that rolls back leaves at most one unreferenced copy that a later identical draft reuses.
   */
  const storeDocument = async (validated: Awaited<ReturnType<typeof validateSemogDraft>>): Promise<SemogStoredPdf> =>
    measuredStore
      ? await putSemogStoredPdf(measuredStore, validated.bytes, { hash: validated.input.arquivo.sha256 })
      : { type: 'BYTES_64', data: Buffer.from(validated.bytes).toString('base64') };
  const persist = async (actor: SemogActor, validated: Awaited<ReturnType<typeof validateSemogDraft>>) => {
    const { input, hash } = validated;
    const document = await timeSemogStage(observe, 'draft.storage', () => storeDocument(validated));
    const result = await timeSemogStage(observe, 'draft.transaction', () =>
      dependencies.client.$transaction(
        async (tx) => {
          await timeSemogStage(observe, 'draft.actor', () => assertActor(tx, actor));
          await timeSemogStage(observe, 'draft.lock', () => lockSemogDraft(tx, actor, input));
          const replay = await timeSemogStage(observe, 'draft.replay', () => replaySemogDraft(tx, actor, input, hash));
          if (replay) {
            return replay;
          }
          const result = await timeSemogStage(observe, 'draft.native', () =>
            createSemogNativeDraft(tx, actor, input, document, observe),
          );
          await timeSemogStage(observe, 'draft.receipt', () => saveSemogDraftReceipt(tx, actor, input, hash, result));
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 60000, maxWait: 10000 },
      ),
    );
    // The row is committed: if the purge removed the object meanwhile, the bytes in memory put it back.
    if (measuredStore && document.type === 'S3_PATH') {
      await timeSemogStage(observe, 'draft.confirm', () =>
        ensureSemogStoredPdf(measuredStore, document.data, validated.bytes),
      );
    }
    return result;
  };
  const create = async (actor: SemogActor, body: unknown) => {
    requireEnabled();
    return await persist(
      actor,
      await timeSemogStage(observe, 'draft.validate', () => validateSemogDraft(body, maximumPdfBytes, observe)),
    );
  };
  const createBinary = async (actor: SemogActor, metadata: unknown, pdf: Uint8Array) => {
    requireEnabled();
    return await persist(
      actor,
      await timeSemogStage(observe, 'draft.validate', () =>
        validateSemogBinaryDraft(metadata, pdf, maximumPdfBytes, observe),
      ),
    );
  };
  return { authenticate, create, createBinary, maximumPdfBytes };
};
export type SemogDraftService = ReturnType<typeof createSemogDraftService>;
