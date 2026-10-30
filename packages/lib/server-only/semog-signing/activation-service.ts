import { Prisma } from '@prisma/client';
import { AppErrorCode } from '../../errors/app-error';
import type { SemogActivationRequest } from './activation-contract';
import { hashSemogActivation, ZSemogActivationRequest, ZSemogActivationResult } from './activation-contract';
import {
  activationConflict,
  lockSemogActivation,
  readSemogActivationDraft,
  readSemogActivationReplay,
  saveSemogActivation,
} from './activation-repository';
import { validateSemogActivationEnvelope } from './activation-validation';
import { readSemogDraftStructure } from './draft-structure';
import type { SemogPrismaTransactionRunner } from './execution';
import { readSemogOutside } from './execution-observed';
import type { SemogPdfStore } from './pdf-store';
import { readSemogStoredPdf } from './pdf-store';
import type { SemogActor } from './service';
import { semogError } from './service-validation';

type Dependencies = {
  enabled?: boolean;
  client: SemogPrismaTransactionRunner;
  pdfStore?: SemogPdfStore;
  authenticate(token: string): Promise<SemogActor | null>;
  now?: () => Date;
};
const validateActor = async (tx: Prisma.TransactionClient, actor: SemogActor) => {
  const user = await tx.user.findFirst({ where: { id: actor.userId, disabled: false }, select: { id: true } });
  const team = await tx.team.findFirst({
    where: { id: actor.teamId, organisation: { owner: { disabled: false } } },
    select: { id: true },
  });
  if (!user || !team) {
    throw semogError(AppErrorCode.UNAUTHORIZED, 401);
  }
};
/**
 * Before the transaction (no lock held during the download): an object-stored draft is read back once and proven
 * against its content address. Returns the proven key; the transaction only accepts that exact key.
 */
const prepareSemogActivationDocument = async (dependencies: Dependencies, actor: SemogActor, envelopeId: string) => {
  const data = await readSemogOutside(dependencies.client, (tx) =>
    tx.documentData.findFirst({
      where: { envelopeItem: { envelopeId, envelope: { teamId: actor.teamId } } },
      select: { type: true, data: true },
    }),
  );
  if (data?.type !== 'S3_PATH') {
    return null;
  }
  if (!dependencies.pdfStore) {
    throw semogError(AppErrorCode.NOT_SETUP, 503);
  }
  await readSemogStoredPdf(dependencies.pdfStore, data.data);
  return data.data;
};
const activateTransaction = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: SemogActivationRequest,
  context: { now: () => Date; verifiedKey: string | null },
) => {
  const { now } = context;
  await validateActor(tx, actor);
  await lockSemogActivation(tx, input);
  const draft = await readSemogActivationDraft(tx, actor, input);
  const hash = hashSemogActivation(input);
  const replay = await readSemogActivationReplay(tx, actor, input, hash);
  const envelope = await readSemogDraftStructure(tx, input.envelopeId);
  if (new Date(input.expiraEm).getTime() <= now().getTime()) {
    throw activationConflict();
  }
  validateSemogActivationEnvelope({
    envelope,
    actor,
    request: input,
    draft: draft.result,
    structureHash: draft.structureHash,
    replay: replay !== null,
    verifiedKey: context.verifiedKey,
  });
  if (replay) {
    return replay;
  }
  return commitActivation(tx, actor, input, hash);
};
const commitActivation = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: SemogActivationRequest,
  hash: string,
) => {
  await tx.recipient.updateMany({
    where: { envelopeId: input.envelopeId, role: { not: 'CC' }, signingStatus: 'NOT_SIGNED' },
    data: { expiresAt: new Date(input.expiraEm), expirationNotifiedAt: null },
  });
  const changed = await tx.envelope.updateMany({
    where: { id: input.envelopeId, status: 'DRAFT' },
    data: { status: 'PENDING' },
  });
  if (changed.count !== 1) {
    throw activationConflict();
  }
  const result = ZSemogActivationResult.parse({
    operacaoId: input.operacaoId,
    envelopeId: input.envelopeId,
    status: 'PENDING',
    expiraEm: input.expiraEm,
    hashPdf: input.hashPdf,
  });
  await saveSemogActivation(tx, actor, input, hash, result);
  return result;
};
/** PENDING enables the Semog signer only; no native send operation, audit claim of delivery or external effect. */
export const createSemogActivationService = (dependencies: Dependencies) => {
  const requireEnabled = () => {
    if (dependencies.enabled !== true) {
      throw semogError(AppErrorCode.NOT_SETUP, 503);
    }
  };
  return {
    authenticate: async (token: string) => {
      requireEnabled();
      const actor = await dependencies.authenticate(token);
      if (!actor) {
        throw semogError(AppErrorCode.UNAUTHORIZED, 401);
      }
      return actor;
    },
    activate: async (actor: SemogActor, body: unknown) => {
      requireEnabled();
      const input = ZSemogActivationRequest.parse(body);
      const verifiedKey = await prepareSemogActivationDocument(dependencies, actor, input.envelopeId);
      const now = dependencies.now ?? (() => new Date());
      return await dependencies.client.$transaction(
        (tx) => activateTransaction(tx, actor, input, { now, verifiedKey }),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 60000, maxWait: 10000 },
      );
    },
  };
};
export type SemogActivationService = ReturnType<typeof createSemogActivationService>;
