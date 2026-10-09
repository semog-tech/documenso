import { Prisma } from '@prisma/client';
import { AppErrorCode } from '../../errors/app-error';
import { createSemogNativeDraft } from './draft-native';
import { lockSemogDraft, replaySemogDraft, saveSemogDraftReceipt } from './draft-repository';
import { semogDraftMaximum, validateSemogDraft } from './draft-validation';
import type { SemogPrismaTransactionRunner } from './execution';
import type { SemogActor } from './service';
import { semogError } from './service-validation';

type Dependencies = {
  enabled?: boolean;
  client: SemogPrismaTransactionRunner;
  authenticate: (token: string) => Promise<SemogActor | null>;
  maximumPdfBytes?: number;
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
  const create = async (actor: SemogActor, body: unknown) => {
    requireEnabled();
    const { input, hash } = await validateSemogDraft(body, maximumPdfBytes);
    return await dependencies.client.$transaction(
      async (tx) => {
        await assertActor(tx, actor);
        await lockSemogDraft(tx, actor, input);
        const replay = await replaySemogDraft(tx, actor, input, hash);
        if (replay) {
          return replay;
        }
        const result = await createSemogNativeDraft(tx, actor, input);
        await saveSemogDraftReceipt(tx, actor, input, hash, result);
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 60000, maxWait: 10000 },
    );
  };
  return { authenticate, create, maximumPdfBytes };
};
export type SemogDraftService = ReturnType<typeof createSemogDraftService>;
