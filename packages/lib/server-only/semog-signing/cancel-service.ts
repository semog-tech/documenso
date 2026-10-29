import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import type { SemogCancelRequest } from './cancel-contract';
import { hashSemogCancel, ZSemogCancelRequest, ZSemogCancelResult } from './cancel-contract';
import {
  hasSemogPendingOperation,
  readSemogCancelReplay,
  revokeSemogEnvelopeEnrollments,
  saveSemogCancelReceipt,
  storeSemogCancelResult,
} from './cancel-repository';
import type { SemogPrismaTransactionRunner } from './execution';
import { isSemogRetryableTransactionError } from './execution';
import { lockSemogEnvelopeWithRecipients } from './extension-repository';
import { assertSemogPartialSealManaged } from './partial-seal-repository';
import { isSemogUniqueViolation, semogRefusal } from './route-refusal';
import type { SemogActor } from './service';
import { semogError } from './service-validation';

type Dependencies = {
  enabled?: boolean;
  client: SemogPrismaTransactionRunner;
  authenticate: (token: string) => Promise<SemogActor | null>;
};
type Request = SemogCancelRequest & { envelopeId: string; hash: string };
const ZEnvelopeId = z.string().min(1).max(255);

/**
 * Direct row update in the native shape (status, completedAt, DOCUMENT_CANCELLED): no native cancel handler
 * runs, so no cancellation e-mail job and no webhook is created.
 */
const cancelEnvelope = async (tx: Prisma.TransactionClient, actor: SemogActor, request: Request) => {
  const canceledAt = new Date();
  const changed = await tx.envelope.updateMany({
    where: { id: request.envelopeId, teamId: actor.teamId, status: 'PENDING' },
    data: { status: 'CANCELLED', completedAt: canceledAt },
  });
  if (changed.count !== 1) {
    throw semogRefusal({ codigo: 'envelope-nao-pendente' });
  }
  await tx.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_CANCELLED,
      envelopeId: request.envelopeId,
      user: { id: actor.userId },
      data: { reason: request.motivo },
    }),
  });
  return canceledAt;
};

const cancelLocked = async (tx: Prisma.TransactionClient, actor: SemogActor, request: Request) => {
  const envelope = await lockSemogEnvelopeWithRecipients(tx, actor, request.envelopeId);
  await assertSemogPartialSealManaged(tx, actor, request.envelopeId);
  const replay = await readSemogCancelReplay(tx, actor, request.envelopeId, request.chaveOperacao, request.hash);
  if (replay) {
    return replay;
  }
  if (envelope.status !== 'PENDING') {
    throw semogRefusal({ codigo: 'envelope-nao-pendente' });
  }
  if (await hasSemogPendingOperation(tx, request.envelopeId)) {
    throw semogRefusal({ codigo: 'operacao-em-andamento' });
  }
  await saveSemogCancelReceipt(tx, actor, request);
  // Status before revocation: the change must pass the guard's receipt branch while the snapshots are live.
  const canceledAt = await cancelEnvelope(tx, actor, request);
  const revoked = await revokeSemogEnvelopeEnrollments(tx, request.envelopeId);
  const result = ZSemogCancelResult.parse({
    chaveOperacao: request.chaveOperacao,
    envelopeId: request.envelopeId,
    situacao: 'cancelado',
    canceladoEm: canceledAt.toISOString(),
    revogados: revoked,
  });
  await storeSemogCancelResult(tx, result);
  return result;
};

/** Cancels a PENDING envelope the bridge activated and closes every live enrollment, durably and idempotently. */
export const createSemogCancelService = (dependencies: Dependencies) => {
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
    create: async (actor: SemogActor, envelopeId: string, body: unknown) => {
      requireEnabled();
      const input = ZSemogCancelRequest.parse(body);
      const id = ZEnvelopeId.parse(envelopeId);
      const request = { ...input, envelopeId: id, hash: hashSemogCancel(id, input) };
      for (let attempt = 0; ; attempt++) {
        try {
          // Read Committed + envelope FOR UPDATE: every signing path takes the same lock, so reads are current.
          return await dependencies.client.$transaction((tx) => cancelLocked(tx, actor, request), {
            isolationLevel: 'ReadCommitted',
            timeout: 30000,
            maxWait: 10000,
          });
        } catch (error) {
          if (isSemogUniqueViolation(error)) {
            throw semogRefusal({ codigo: 'chave-reutilizada' });
          }
          if (attempt === 2 || !isSemogRetryableTransactionError(error)) {
            throw error;
          }
        }
      }
    },
  };
};
export type SemogCancelService = ReturnType<typeof createSemogCancelService>;
