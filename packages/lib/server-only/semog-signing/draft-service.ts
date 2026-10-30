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

type Dependencies = {
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
    dependencies.pdfStore
      ? await putSemogStoredPdf(dependencies.pdfStore, validated.bytes, { hash: validated.input.arquivo.sha256 })
      : { type: 'BYTES_64', data: Buffer.from(validated.bytes).toString('base64') };
  const persist = async (actor: SemogActor, validated: Awaited<ReturnType<typeof validateSemogDraft>>) => {
    const { input, hash } = validated;
    const document = await storeDocument(validated);
    const result = await dependencies.client.$transaction(
      async (tx) => {
        await assertActor(tx, actor);
        await lockSemogDraft(tx, actor, input);
        const replay = await replaySemogDraft(tx, actor, input, hash);
        if (replay) {
          return replay;
        }
        const result = await createSemogNativeDraft(tx, actor, input, document);
        await saveSemogDraftReceipt(tx, actor, input, hash, result);
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 60000, maxWait: 10000 },
    );
    // The row is committed: if the purge removed the object meanwhile, the bytes in memory put it back.
    if (dependencies.pdfStore && document.type === 'S3_PATH') {
      await ensureSemogStoredPdf(dependencies.pdfStore, document.data, validated.bytes);
    }
    return result;
  };
  const create = async (actor: SemogActor, body: unknown) => {
    requireEnabled();
    return await persist(actor, await validateSemogDraft(body, maximumPdfBytes));
  };
  const createBinary = async (actor: SemogActor, metadata: unknown, pdf: Uint8Array) => {
    requireEnabled();
    return await persist(actor, await validateSemogBinaryDraft(metadata, pdf, maximumPdfBytes));
  };
  return { authenticate, create, createBinary, maximumPdfBytes };
};
export type SemogDraftService = ReturnType<typeof createSemogDraftService>;
