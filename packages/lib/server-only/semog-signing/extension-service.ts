import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import type { SemogPrismaTransactionRunner } from './execution';
import { isSemogRetryableTransactionError } from './execution';
import { normalizeSemogExtension, ZSemogExtensionRequest } from './extension-contract';
import {
  extensionConflict,
  readSemogActiveSnapshots,
  readSemogExtensionReplay,
  readSemogOperationRecipients,
  recordSemogExtension,
} from './extension-repository';
import { assertSemogPartialSealManaged } from './partial-seal-repository';
import type { SemogRefusedRecipient } from './route-refusal';
import { isSemogUniqueViolation, semogRefusal } from './route-refusal';
import type { SemogActor } from './service';
import { semogError } from './service-validation';

type Dependencies = {
  enabled?: boolean;
  client: SemogPrismaTransactionRunner;
  authenticate: (token: string) => Promise<SemogActor | null>;
  now?: () => Date;
};
type Request = ReturnType<typeof normalizeSemogExtension> & { chaveOperacao: string; envelopeId: string };
const ZEnvelopeId = z.string().min(1).max(255);

const lockEnvelope = async (tx: Prisma.TransactionClient, actor: SemogActor, envelopeId: string) => {
  const lock = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM public."Envelope" WHERE id=${envelopeId} AND "teamId"=${actor.teamId} FOR UPDATE`,
  );
  if (lock.length !== 1) {
    throw semogError(AppErrorCode.NOT_FOUND, 404);
  }
  return await tx.envelope.findFirstOrThrow({ where: { id: envelopeId }, include: { recipients: true } });
};
type Envelope = Awaited<ReturnType<typeof lockEnvelope>>;

const refusedReason = (
  recipient: Envelope['recipients'][number] | undefined,
  operations: Set<number>,
  expiry: number,
): SemogRefusedRecipient['motivo'] | null => {
  if (!recipient) {
    return 'nao-encontrado';
  }
  if (recipient.role !== 'SIGNER') {
    return 'nao-signatario';
  }
  if (recipient.signingStatus !== 'NOT_SIGNED') {
    return 'ja-assinou';
  }
  // Kept out on purpose: the unique (envelopeId, recipientId) on operations would block a new signature anyway.
  if (operations.has(recipient.id)) {
    return 'operacao-existente';
  }
  if (recipient.expiresAt === null) {
    return 'sem-prazo';
  }
  return recipient.expiresAt.getTime() >= expiry ? 'prazo-nao-avanca' : null;
};

/** Envelope-level gates first; then every target is checked so one answer names all ineligible recipients. */
const listRefusedTargets = (envelope: Envelope, request: Request, operations: Set<number>, now: Date) => {
  const expiry = Date.parse(request.expiraEm);
  if (envelope.status !== 'PENDING') {
    throw semogRefusal({ codigo: 'envelope-nao-pendente' });
  }
  if (envelope.recipients.some((recipient) => recipient.signingStatus === 'REJECTED')) {
    throw semogRefusal({ codigo: 'envelope-com-recusa' });
  }
  if (expiry <= now.getTime()) {
    throw semogRefusal({ codigo: 'prazo-no-passado' });
  }
  return request.recipientIds.flatMap((id): SemogRefusedRecipient[] => {
    const motivo = refusedReason(
      envelope.recipients.find((candidate) => candidate.id === id),
      operations,
      expiry,
    );
    return motivo ? [{ recipientId: id, motivo }] : [];
  });
};

/**
 * Recipient.expiresAt is part of every enrollment snapshot. Moving the deadline of a recipient outside a
 * live enrollment of someone else would make that enrollment's pending signature fail its hash check.
 */
const listLiveForeignEnrollments = async (tx: Prisma.TransactionClient, envelope: Envelope, request: Request) => {
  const missing = new Set(
    envelope.recipients
      .filter((recipient) => recipient.role === 'SIGNER' && recipient.signingStatus === 'NOT_SIGNED')
      .map((recipient) => recipient.id),
  );
  const snapshots = await readSemogActiveSnapshots(tx, envelope.id);
  const blocking = snapshots
    .filter(
      (snapshot) =>
        snapshot.vigente && missing.has(snapshot.recipientId) && !request.recipientIds.includes(snapshot.recipientId),
    )
    .map((snapshot) => snapshot.recipientId);
  return [...new Set(blocking)].map(
    (recipientId): SemogRefusedRecipient => ({ recipientId, motivo: 'inscricao-vigente' }),
  );
};

const applyExtension = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelope: Envelope,
  request: Request,
) => {
  const result = await recordSemogExtension(tx, actor, request);
  const changed = await tx.recipient.updateMany({
    where: { envelopeId: envelope.id, id: { in: request.recipientIds }, signingStatus: 'NOT_SIGNED' },
    data: { expiresAt: new Date(request.expiraEm), expirationNotifiedAt: null },
  });
  if (changed.count !== request.recipientIds.length) {
    throw extensionConflict();
  }
  for (const id of request.recipientIds) {
    const recipient = envelope.recipients.find((candidate) => candidate.id === id);
    if (!recipient) {
      throw extensionConflict();
    }
    // Native audit vocabulary has no deadline diff; the instant itself lives in the durable receipt.
    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED,
        envelopeId: envelope.id,
        user: { id: actor.userId },
        data: {
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          recipientId: recipient.id,
          recipientRole: recipient.role,
          changes: [],
        },
      }),
    });
  }
  return result;
};

const extendLocked = async (
  tx: Prisma.TransactionClient,
  dependencies: Dependencies,
  actor: SemogActor,
  request: Request,
) => {
  const envelope = await lockEnvelope(tx, actor, request.envelopeId);
  await assertSemogPartialSealManaged(tx, actor, request.envelopeId);
  const replay = await readSemogExtensionReplay(tx, actor, request.envelopeId, request.chaveOperacao, request.hash);
  if (replay) {
    return replay;
  }
  const operations = await readSemogOperationRecipients(tx, request.envelopeId);
  const refused = [
    ...listRefusedTargets(envelope, request, operations, (dependencies.now ?? (() => new Date()))()),
    ...(await listLiveForeignEnrollments(tx, envelope, request)),
  ].sort((a, b) => a.recipientId - b.recipientId);
  if (refused.length > 0) {
    throw semogRefusal({ codigo: 'destinatarios-inelegiveis', destinatarios: refused });
  }
  return await applyExtension(tx, actor, envelope, request);
};

/** Reopens a round: revokes the old enrollment and moves Recipient.expiresAt, so /inscricoes accepts a new one. */
export const createSemogExtensionService = (dependencies: Dependencies) => {
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
      const input = ZSemogExtensionRequest.parse(body);
      const id = ZEnvelopeId.parse(envelopeId);
      const request = { ...normalizeSemogExtension(id, input), chaveOperacao: input.chaveOperacao, envelopeId: id };
      for (let attempt = 0; ; attempt++) {
        try {
          // Read Committed + envelope FOR UPDATE, as the partial seal: reads after the lock see current state.
          return await dependencies.client.$transaction((tx) => extendLocked(tx, dependencies, actor, request), {
            isolationLevel: 'ReadCommitted',
            timeout: 30000,
            maxWait: 10000,
          });
        } catch (error) {
          if (isSemogUniqueViolation(error)) {
            // Same key committed meanwhile for another envelope: the same answer as a reused key.
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
export type SemogExtensionService = ReturnType<typeof createSemogExtensionService>;
