import type { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import {
  ZDocumentAuditLogEventDocumentFieldInsertedSchema,
  ZDocumentAuditLogEventDocumentRecipientCompleteSchema,
  ZDocumentAuditLogEventDocumentRecipientRejectedSchema,
} from '../../types/document-audit-logs';
import { semogAuthenticationMethod } from './auth-evidence';
import type { SemogEnvelopeSnapshotSource } from './contract';
import type { readSemogNativeEnvelope } from './native-envelope';
import type { SemogManifestation } from './service-validation';
import { semogVisualDataUrl } from './visual';

type NativeEnvelope = Awaited<ReturnType<typeof readSemogNativeEnvelope>>['envelope'];
type Recipient = SemogEnvelopeSnapshotSource['recipients'][number];
const recipientData = (recipient: Recipient) => ({
  recipientId: recipient.id,
  recipientEmail: recipient.email,
  recipientName: recipient.name,
  recipientRole: recipient.role,
});
const auditBase = (input: SemogManifestation, recipient: Recipient) => ({
  envelopeId: input.envelopeId,
  name: recipient.name,
  email: recipient.email,
  userId: null,
  ipAddress: input.evidencias.ip,
  userAgent: input.evidencias.userAgent,
});
const auditAuthentication = (input: SemogManifestation) => ({
  canal: input.evidencias.canal,
  metodoAutenticacao: semogAuthenticationMethod(input.evidencias),
  identificacaoId: input.evidencias.identificacaoId,
  confirmadoEm: input.evidencias.confirmadoEm,
});
const persistSignature = async (
  tx: Prisma.TransactionClient,
  input: SemogManifestation,
  recipient: Recipient,
  value: SemogManifestation['campos'][number],
) => {
  const image = input.assinaturaVisual?.fieldId === value.fieldId ? semogVisualDataUrl(input.assinaturaVisual) : null;
  const signature = { typedSignature: image === null ? value.valor : null, signatureImageAsBase64: image };
  await tx.signature.upsert({
    where: { fieldId: value.fieldId },
    create: { fieldId: value.fieldId, recipientId: recipient.id, ...signature },
    update: signature,
  });
};
const completeRecipient = async (tx: Prisma.TransactionClient, input: SemogManifestation, recipient: Recipient) => {
  const result = await tx.recipient.updateMany({
    where: { id: recipient.id, envelopeId: input.envelopeId, signingStatus: 'NOT_SIGNED', signedAt: null },
    data: {
      signingStatus: input.acao === 'assinar' ? 'SIGNED' : 'REJECTED',
      signedAt: new Date(),
      ...(input.acao === 'recusar' ? { rejectionReason: input.motivo ?? 'Documento recusado.' } : {}),
    },
  });
  if (result.count !== 1) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
  }
  const event =
    input.acao === 'assinar'
      ? ZDocumentAuditLogEventDocumentRecipientCompleteSchema.parse({
          type: 'DOCUMENT_RECIPIENT_COMPLETED',
          data: { ...recipientData(recipient), actionAuth: [] },
        })
      : ZDocumentAuditLogEventDocumentRecipientRejectedSchema.parse({
          type: 'DOCUMENT_RECIPIENT_REJECTED',
          data: { ...recipientData(recipient), reason: input.motivo ?? 'Documento recusado.', isExternal: true },
        });
  const audit = await tx.documentAuditLog.create({
    data: {
      ...auditBase(input, recipient),
      ...event,
      // Native actionAuth cannot express Semog link/code verification; keep its methods unchanged.
      data: { ...event.data, semog: auditAuthentication(input) },
    },
  });
  return audit.id;
};

const insertField = async (
  tx: Prisma.TransactionClient,
  envelope: NativeEnvelope,
  input: SemogManifestation,
  recipient: Recipient,
  value: SemogManifestation['campos'][number],
) => {
  const field = envelope.fields.find(
    (candidate) => candidate.id === value.fieldId && candidate.recipientId === recipient.id,
  );
  if (!field || !['TEXT', 'SIGNATURE'].includes(field.type)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
  }
  const result = await tx.field.updateMany({
    where: { id: field.id, recipientId: recipient.id, inserted: false },
    data: { inserted: true, ...(field.type === 'TEXT' ? { customText: value.valor } : {}) },
  });
  if (result.count !== 1) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
  }
  if (field.type === 'SIGNATURE') {
    await persistSignature(tx, input, recipient, value);
  }
  const event = ZDocumentAuditLogEventDocumentFieldInsertedSchema.parse({
    type: 'DOCUMENT_FIELD_INSERTED',
    data: {
      ...recipientData(recipient),
      fieldId: field.secondaryId,
      field: { type: field.type, data: value.valor },
    },
  });
  const audit = await tx.documentAuditLog.create({
    data: {
      ...auditBase(input, recipient),
      ...event,
      data: { ...event.data, semog: auditAuthentication(input) },
    },
  });
  return audit.id;
};

export const applySemogNativeManifestation = async (
  tx: Prisma.TransactionClient,
  envelope: NativeEnvelope,
  input: SemogManifestation,
  recipient: Recipient,
) => {
  const auditIds: string[] = [];
  if (input.acao === 'assinar') {
    for (const field of input.campos) {
      auditIds.push(await insertField(tx, envelope, input, recipient, field));
    }
    if (input.assinaturaVisual) {
      auditIds.push(
        await insertField(tx, envelope, input, recipient, {
          fieldId: input.assinaturaVisual.fieldId,
          valor: semogVisualDataUrl(input.assinaturaVisual),
        }),
      );
    }
  }
  auditIds.push(await completeRecipient(tx, input, recipient));
  return auditIds;
};
