import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import type { SemogContactRequest } from './contact-contract';
import { hashSemogContact, ZSemogContactRequest, ZSemogContactResult } from './contact-contract';
import type { SemogRevokedEnrollment } from './contact-repository';
import {
  readSemogContactReplay,
  registerSemogSnapshot,
  revokeSemogMissingEnrollments,
  saveSemogContactReceipt,
} from './contact-repository';
import type { SemogPrismaTransactionRunner } from './execution';
import { isSemogRetryableTransactionError } from './execution';
import type { SemogLockedEnvelope } from './extension-repository';
import { lockSemogEnvelopeWithRecipients, readSemogOperationRecipients } from './extension-repository';
import type { SemogPdfReader } from './initial-pdf';
import { readSemogNativeEnvelope } from './native-envelope';
import { assertSemogPartialSealManaged } from './partial-seal-repository';
import type { SemogRefusedRecipient } from './route-refusal';
import { isSemogUniqueViolation, semogRefusal } from './route-refusal';
import type { SemogActor } from './service';
import { semogError } from './service-validation';
import { buildSemogSnapshot } from './snapshot';

type Dependencies = {
  enabled?: boolean;
  client: SemogPrismaTransactionRunner;
  readPdf: SemogPdfReader;
  authenticate: (token: string) => Promise<SemogActor | null>;
};
type Request = SemogContactRequest & { envelopeId: string; hash: string };
const ZEnvelopeId = z.string().min(1).max(255);

const targetRefusal = (envelope: SemogLockedEnvelope, request: Request): SemogRefusedRecipient['motivo'] | null => {
  const target = envelope.recipients.find((recipient) => recipient.id === request.recipientId);
  if (!target) {
    return 'nao-encontrado';
  }
  if (target.role !== 'SIGNER') {
    return 'nao-signatario';
  }
  if (target.signingStatus !== 'NOT_SIGNED') {
    return 'ja-assinou';
  }
  if (target.email.trim().toLowerCase() === request.email) {
    return 'email-inalterado';
  }
  const taken = envelope.recipients.some(
    (recipient) => recipient.id !== target.id && recipient.email.trim().toLowerCase() === request.email,
  );
  return taken ? 'email-em-uso' : null;
};

/** Envelope gates, the target, then anyone mid-signature (retryable): nothing is written before all pass. */
const assertChangeable = async (tx: Prisma.TransactionClient, envelope: SemogLockedEnvelope, request: Request) => {
  if (envelope.status !== 'PENDING') {
    throw semogRefusal({ codigo: 'envelope-nao-pendente' });
  }
  if (envelope.recipients.some((recipient) => recipient.signingStatus === 'REJECTED')) {
    throw semogRefusal({ codigo: 'envelope-com-recusa' });
  }
  const motivo = targetRefusal(envelope, request);
  if (motivo) {
    throw semogRefusal({
      codigo: 'destinatarios-inelegiveis',
      destinatarios: [{ recipientId: request.recipientId, motivo }],
    });
  }
  const missing = envelope.recipients
    .filter((recipient) => recipient.role === 'SIGNER' && recipient.signingStatus === 'NOT_SIGNED')
    .map((recipient) => recipient.id)
    .sort((a, b) => a - b);
  const operations = await readSemogOperationRecipients(tx, envelope.id);
  const inFlight = missing.filter((id) => operations.has(id));
  if (inFlight.length > 0) {
    throw semogRefusal({
      codigo: 'operacao-em-andamento',
      destinatarios: inFlight.map((recipientId) => ({ recipientId, motivo: 'operacao-existente' as const })),
    });
  }
  return missing;
};

/**
 * Every snapshot carries every recipient's e-mail, so each live missing enrollment is rebuilt from the current
 * envelope with its own consent text and deadline. The Semog app keeps its hashes; links stay bound to the id.
 */
const reenroll = async (
  tx: Prisma.TransactionClient,
  dependencies: Dependencies,
  actor: SemogActor,
  envelopeId: string,
  enrollments: SemogRevokedEnrollment[],
) => {
  const current = await readSemogNativeEnvelope(tx, envelopeId, actor);
  const data = current.envelope.envelopeItems[0].documentData;
  const pdf = await dependencies.readPdf({ documentDataId: data.id, type: data.type, data: data.initialData });
  for (const enrollment of enrollments) {
    let snapshot: ReturnType<typeof buildSemogSnapshot>;
    try {
      snapshot = buildSemogSnapshot({
        teamId: actor.teamId,
        envelope: current.source,
        pdf,
        recipientId: enrollment.recipientId,
        consentimento: enrollment.consentimento ?? '',
        expiraEm: enrollment.expiraEm.toISOString(),
      });
    } catch {
      throw semogRefusal({
        codigo: 'destinatarios-inelegiveis',
        destinatarios: [{ recipientId: enrollment.recipientId, motivo: 'reinscricao-impossivel' }],
      });
    }
    await registerSemogSnapshot(tx, snapshot);
  }
};

const changeLocked = async (
  tx: Prisma.TransactionClient,
  dependencies: Dependencies,
  actor: SemogActor,
  request: Request,
) => {
  const envelope = await lockSemogEnvelopeWithRecipients(tx, actor, request.envelopeId);
  await assertSemogPartialSealManaged(tx, actor, request.envelopeId);
  const replay = await readSemogContactReplay(tx, actor, request.envelopeId, request.chaveOperacao, request.hash);
  if (replay) {
    return replay;
  }
  const missing = await assertChangeable(tx, envelope, request);
  const revoked = await revokeSemogMissingEnrollments(tx, request.chaveOperacao, request.envelopeId, missing);
  const live = revoked.filter((enrollment) => enrollment.vigente && enrollment.consentimento !== null);
  const result = ZSemogContactResult.parse({
    chaveOperacao: request.chaveOperacao,
    envelopeId: request.envelopeId,
    recipientId: request.recipientId,
    email: request.email,
    revogados: [...new Set(revoked.map((enrollment) => enrollment.recipientId))],
    reinscritos: live.map((enrollment) => enrollment.recipientId),
  });
  const previous = envelope.recipients.find((recipient) => recipient.id === request.recipientId);
  if (!previous) {
    throw semogError(AppErrorCode.NOT_FOUND, 404);
  }
  // The guard only lets this e-mail through once this transaction's receipt names it.
  await saveSemogContactReceipt(tx, actor, { previousEmail: previous.email, hash: request.hash, result });
  await updateEmail(tx, actor, previous, request);
  await reenroll(tx, dependencies, actor, request.envelopeId, live);
  return result;
};

/** Direct row update: no native recipient-update handler runs, so no e-mail is sent to the new address. */
const updateEmail = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  previous: SemogLockedEnvelope['recipients'][number],
  request: Request,
) => {
  const changed = await tx.recipient.updateMany({
    where: { id: request.recipientId, envelopeId: request.envelopeId, signingStatus: 'NOT_SIGNED' },
    data: { email: request.email },
  });
  if (changed.count !== 1) {
    throw semogRefusal({
      codigo: 'destinatarios-inelegiveis',
      destinatarios: [{ recipientId: request.recipientId, motivo: 'ja-assinou' }],
    });
  }
  await tx.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED,
      envelopeId: request.envelopeId,
      user: { id: actor.userId },
      data: {
        recipientEmail: request.email,
        recipientName: previous.name,
        recipientId: previous.id,
        recipientRole: previous.role,
        changes: [{ type: 'EMAIL', from: previous.email, to: request.email }],
      },
    }),
  });
};

/** Corrects a missing signer's e-mail on a sent envelope without breaking the other missing signers' links. */
export const createSemogContactService = (dependencies: Dependencies) => {
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
      const input = ZSemogContactRequest.parse(body);
      const id = ZEnvelopeId.parse(envelopeId);
      const request = { ...input, envelopeId: id, hash: hashSemogContact(id, input) };
      for (let attempt = 0; ; attempt++) {
        try {
          // Read Committed + envelope FOR UPDATE: every signing path takes the same lock, so reads are current.
          return await dependencies.client.$transaction((tx) => changeLocked(tx, dependencies, actor, request), {
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
export type SemogContactService = ReturnType<typeof createSemogContactService>;
