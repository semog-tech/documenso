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
import type { SemogActor } from './service';
import { semogError } from './service-validation';

type Dependencies = {
  enabled?: boolean;
  client: SemogPrismaTransactionRunner;
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
const activateTransaction = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: SemogActivationRequest,
  now: () => Date,
) => {
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
      return await dependencies.client.$transaction(
        (tx) => activateTransaction(tx, actor, input, dependencies.now ?? (() => new Date())),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 60000, maxWait: 10000 },
      );
    },
  };
};
export type SemogActivationService = ReturnType<typeof createSemogActivationService>;
