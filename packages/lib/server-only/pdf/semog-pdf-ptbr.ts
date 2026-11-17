import type { I18n } from '@lingui/core';
import type Konva from 'konva';
import { DateTime } from 'luxon';

import { APP_I18N_OPTIONS } from '../../constants/i18n';

export const isSemogPdfPtBr = (metadata: { language: string; dateFormat: string | null }) =>
  metadata.language === 'pt-BR' && metadata.dateFormat === 'dd/MM/yyyy HH:mm:ss';

const presentations = new WeakSet<I18n>();

/** Per-render opt-in; no stored PDF, audit record or historical metadata is rewritten. */
export const semogPdfI18n = (local: I18n): I18n => {
  presentations.add(local);
  return local;
};

export const semogPdfAtivo = (i18n: I18n): boolean => presentations.has(i18n);

export const formatPdfDate = (date: Date, i18n: I18n): string => {
  const instant = DateTime.fromJSDate(date);
  return semogPdfAtivo(i18n)
    ? instant.setLocale('pt-BR').setZone('America/Fortaleza').toFormat('dd/MM/yyyy HH:mm:ss (ZZZZ)')
    : instant.setLocale(APP_I18N_OPTIONS.defaultLocale).toFormat('yyyy-MM-dd hh:mm:ss a (ZZZZ)');
};

const EVENTOS: Record<string, string> = {
  DOCUMENT_RECIPIENT_CSC_AUTHENTICATED: 'Autenticação no provedor concluída',
  DOCUMENT_RECIPIENT_CSC_AUTHENTICATION_FAILED: 'Falha na autenticação no provedor',
  DOCUMENT_RECIPIENT_CSC_SIGN_REQUESTED: 'Assinatura no provedor solicitada',
  DOCUMENT_RECIPIENT_CSC_AUTHORIZED: 'Assinatura no provedor autorizada',
  DOCUMENT_RECIPIENT_CSC_SIGNED: 'Assinatura no provedor concluída',
  EMAIL_SENT: 'E-mail enviado',
  FIELD_CREATED: 'Campo criado',
  FIELD_DELETED: 'Campo excluído',
  FIELD_UPDATED: 'Campo atualizado',
  RECIPIENT_CREATED: 'Participante incluído',
  RECIPIENT_DELETED: 'Participante removido',
  RECIPIENT_UPDATED: 'Participante atualizado',
  ENVELOPE_ITEM_CREATED: 'Documento incluído',
  ENVELOPE_ITEM_DELETED: 'Documento removido',
  ENVELOPE_ITEM_UPDATED: 'Documento atualizado',
  ENVELOPE_ITEM_PDF_REPLACED: 'PDF substituído',
  DOCUMENT_CANCELLED: 'Documento cancelado',
  DOCUMENT_COMPLETED: 'Documento concluído',
  DOCUMENT_CREATED: 'Documento criado',
  DOCUMENT_DELETED: 'Documento excluído',
  DOCUMENT_FIELDS_AUTO_INSERTED: 'Campos preenchidos automaticamente',
  DOCUMENT_FIELD_INSERTED: 'Campo preenchido',
  DOCUMENT_FIELD_UNINSERTED: 'Preenchimento removido',
  DOCUMENT_FIELD_PREFILLED: 'Campo preparado',
  DOCUMENT_VISIBILITY_UPDATED: 'Visibilidade atualizada',
  DOCUMENT_GLOBAL_AUTH_ACCESS_UPDATED: 'Verificação de acesso atualizada',
  DOCUMENT_GLOBAL_AUTH_ACTION_UPDATED: 'Verificação da assinatura atualizada',
  DOCUMENT_META_UPDATED: 'Dados do documento atualizados',
  DOCUMENT_OPENED: 'Documento aberto',
  DOCUMENT_VIEWED: 'Documento visualizado',
  DOCUMENT_RECIPIENT_REJECTED: 'Assinatura recusada',
  DOCUMENT_RECIPIENT_COMPLETED: 'Assinatura concluída',
  DOCUMENT_RECIPIENT_EXPIRED: 'Prazo de assinatura encerrado',
  DOCUMENT_SENT: 'Documento enviado',
  DOCUMENT_TITLE_UPDATED: 'Título atualizado',
  DOCUMENT_EXTERNAL_ID_UPDATED: 'Referência atualizada',
  DOCUMENT_MOVED_TO_TEAM: 'Documento transferido',
  DOCUMENT_DELEGATED_OWNER_CREATED: 'Responsável incluído',
  DOCUMENT_ACCESS_AUTH_2FA_REQUESTED: 'Verificação solicitada',
  DOCUMENT_ACCESS_AUTH_2FA_VALIDATED: 'Verificação confirmada',
  DOCUMENT_ACCESS_AUTH_2FA_FAILED: 'Verificação recusada',
};
export const eventoSemogPtBr = (tipo: string) => EVENTOS[tipo] ?? 'Evento registrado';

/** Keep complete email addresses on one line without clipping them at column boundaries. */
export const fitPdfWords = (text: Konva.Text) => {
  const longest = Math.max(
    ...text
      .text()
      .split(/\s+/)
      .map((word) => text.measureSize(word).width),
  );
  if (longest > text.width()) {
    text.fontSize((0.98 * text.fontSize() * text.width()) / longest);
  }
};
