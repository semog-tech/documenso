import type { TDocumentAuditLog } from '@documenso/lib/types/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { PDF } from '@libpdf/core';
import { setupI18n } from '@lingui/core';

import { ZSupportedLanguageCodeSchema } from '../../constants/i18n';
import { parseDocumentAuditLogData } from '../../utils/document-audit-logs';
import { getTranslations } from '../../utils/i18n';
import { getOrganisationClaimByTeamId } from '../organisation/get-organisation-claims';
import type { GenerateCertificatePdfOptions } from './generate-certificate-pdf';
import { renderAuditLogs } from './render-audit-logs';
import { isSemogPdfPtBr, semogPdfI18n } from './semog-pdf-ptbr';

type GenerateAuditLogPdfOptions = GenerateCertificatePdfOptions & {
  envelopeItems: string[];
  additionalAuditLogs?: TDocumentAuditLog[];
};

export const generateAuditLogPdf = async (options: GenerateAuditLogPdfOptions) => {
  const {
    envelope,
    envelopeOwner,
    envelopeItems,
    recipients,
    language,
    pageWidth,
    pageHeight,
    additionalAuditLogs = [],
  } = options;

  const semogPtBr = isSemogPdfPtBr(envelope.documentMeta);
  const documentLanguage = ZSupportedLanguageCodeSchema.parse(semogPtBr ? 'pt-BR' : language);

  const [organisationClaim, partialAuditLogs, messages] = await Promise.all([
    getOrganisationClaimByTeamId({ teamId: envelope.teamId }),
    getAuditLogs(envelope.id),
    getTranslations(documentLanguage),
  ]);

  const i18n = setupI18n({ locale: documentLanguage, messages: { [documentLanguage]: messages } });

  const auditLogs: TDocumentAuditLog[] = [...additionalAuditLogs, ...partialAuditLogs];

  const auditLogPages = await renderAuditLogs({
    envelope,
    envelopeOwner,
    envelopeItems,
    recipients,
    auditLogs,
    hidePoweredBy: semogPtBr || (organisationClaim.flags.hidePoweredBy ?? false),
    pageWidth,
    pageHeight,
    i18n: semogPtBr ? semogPdfI18n(i18n) : i18n,
  });

  return await PDF.merge(auditLogPages, {
    includeAnnotations: true,
  });
};

const getAuditLogs = async (envelopeId: string) => {
  const auditLogs = await prisma.documentAuditLog.findMany({
    where: {
      envelopeId,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return auditLogs.map((auditLog) => parseDocumentAuditLogData(auditLog));
};
