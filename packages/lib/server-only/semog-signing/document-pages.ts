import type { I18n, Messages } from '@lingui/core';
import { setupI18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Prisma, Recipient } from '@prisma/client';
import { z } from 'zod';
import { ZSupportedLanguageCodeSchema } from '../../constants/locales';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { TDocumentAuditLog } from '../../types/document-audit-logs';
import { ZDocumentAuditLogSchema } from '../../types/document-audit-logs';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import { renderAuditLogs } from '../pdf/render-audit-logs';
import type { CertificateRecipient } from '../pdf/render-certificate';
import { renderCertificate } from '../pdf/render-certificate';
import {
  type SemogAuthenticationEvidence,
  semogAuthenticationLabel,
  ZSemogAuthenticationEvidence,
} from './auth-evidence';

export type SemogDocumentI18n = (language: string) => Promise<I18n>;
/** Host loads its compiled native catalogue; each document gets an isolated Lingui instance. */
export const createSemogDocumentI18n =
  (load: (language: string) => Promise<Messages>): SemogDocumentI18n =>
  async (language) => {
    const locale = ZSupportedLanguageCodeSchema.parse(language);
    return setupI18n({ locale, messages: { [locale]: await load(locale) } });
  };

type NativePagesEnvelope = Parameters<typeof renderAuditLogs>[0]['envelope'] & {
  recipients: Recipient[];
  fields: (NonNullable<CertificateRecipient['signatureField']> & { type: string })[];
  envelopeItems: { title: string }[];
  user: { name: string | null; email: string };
};
const claimSchema = z.object({ hidePoweredBy: z.boolean().optional() });
const actionLabels = {
  ACCOUNT: msg`Account Re-Authentication`,
  TWO_FACTOR_AUTH: msg`Two-Factor Re-Authentication`,
  PASSWORD: msg`Password Re-Authentication`,
  PASSKEY: msg`Passkey Re-Authentication`,
  EXPLICIT_NONE: msg`Email`,
};

const recipientLog = (logs: TDocumentAuditLog[], type: TDocumentAuditLog['type'], recipientId: number) =>
  logs.find((log) => log.type === type && 'recipientId' in log.data && log.data.recipientId === recipientId) ?? null;

const authenticationLabel = (
  recipient: Recipient,
  envelope: NativePagesEnvelope,
  logs: TDocumentAuditLog[],
  i18n: I18n,
  evidence?: SemogAuthenticationEvidence,
) => {
  if (evidence) {
    return semogAuthenticationLabel(evidence);
  }
  const inserted = logs.find(
    (log) => log.type === 'DOCUMENT_FIELD_INSERTED' && log.data.recipientId === recipient.id && log.data.fieldSecurity,
  );
  const method = inserted?.type === 'DOCUMENT_FIELD_INSERTED' ? inserted.data.fieldSecurity?.type : undefined;
  if (method) {
    return i18n._(actionLabels[method]);
  }
  const access = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
    recipientAuth: recipient.authOptions,
  }).derivedRecipientAccessAuth[0];
  return i18n._(
    access === 'ACCOUNT'
      ? msg`Account Authentication`
      : access === 'TWO_FACTOR_AUTH'
        ? msg`Two-Factor Authentication`
        : msg`Email`,
  );
};

const certificateRecipient = (
  recipient: NativePagesEnvelope['recipients'][number],
  envelope: NativePagesEnvelope,
  logs: TDocumentAuditLog[],
  channels: Map<number, SemogAuthenticationEvidence>,
  i18n: I18n,
): CertificateRecipient => ({
  ...recipient,
  signatureField: envelope.fields.find((field) => field.recipientId === recipient.id && field.type === 'SIGNATURE'),
  // Bridge contact evidence is server-produced; WhatsApp must never be labelled as email authentication.
  authLevel: authenticationLabel(recipient, envelope, logs, i18n, channels.get(recipient.id)),
  logs: {
    emailed: recipientLog(logs, 'EMAIL_SENT', recipient.id),
    sent: logs.find((log) => log.type === 'DOCUMENT_SENT') ?? null,
    opened: recipientLog(logs, 'DOCUMENT_OPENED', recipient.id),
    completed: recipientLog(logs, 'DOCUMENT_RECIPIENT_COMPLETED', recipient.id),
    rejected: recipientLog(logs, 'DOCUMENT_RECIPIENT_REJECTED', recipient.id),
  },
});

const readPageEvidence = async (tx: Prisma.TransactionClient, envelope: NativePagesEnvelope) => {
  const claim = await tx.organisationClaim.findFirst({
    where: { organisation: { teams: { some: { id: envelope.teamId } } } },
  });
  if (!claim) {
    throw new AppError(AppErrorCode.NOT_FOUND, { statusCode: 404 });
  }
  const rows = await tx.documentAuditLog.findMany({
    where: { envelopeId: envelope.id },
    orderBy: { createdAt: 'desc' },
  });
  const logs = rows.map((row) => ZDocumentAuditLogSchema.parse(row));
  const operations = await tx.$queryRaw<{ recipientId: number; evidencias: unknown }[]>`
    SELECT "recipientId", evidencias FROM semog_bridge.operations
    WHERE "envelopeId"=${envelope.id} AND "teamId"=${envelope.teamId} AND estado='concluida'`;
  const channels = new Map(
    operations.map((operation) => [operation.recipientId, ZSemogAuthenticationEvidence.parse(operation.evidencias)]),
  );
  return { logs, channels, hidePoweredBy: claimSchema.parse(claim.flags).hidePoweredBy ?? false };
};

export const renderSemogDocumentPages = async (
  tx: Prisma.TransactionClient,
  envelope: NativePagesEnvelope,
  dimensions: { width: number; height: number },
  i18n: I18n,
) => {
  if (i18n.locale !== ZSupportedLanguageCodeSchema.parse(envelope.documentMeta.language)) {
    throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
  }
  const { logs, channels, hidePoweredBy } = await readPageEvidence(tx, envelope);
  const common = {
    envelopeOwner: { email: envelope.user.email, name: envelope.user.name ?? '' },
    hidePoweredBy,
    pageWidth: dimensions.width,
    pageHeight: dimensions.height,
    i18n,
  };
  const certificate = await renderCertificate({
    ...common,
    envelopeId: envelope.id,
    qrToken: envelope.qrToken,
    recipients: envelope.recipients.map((recipient) => certificateRecipient(recipient, envelope, logs, channels, i18n)),
  });
  const audit = await renderAuditLogs({
    ...common,
    envelope,
    envelopeItems: envelope.envelopeItems.map((item) => item.title),
    recipients: envelope.recipients,
    auditLogs: logs,
  });
  return [...certificate, ...audit];
};
