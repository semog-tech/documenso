import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';
import { ZDocumentAuditLogSchema } from '../types/document-audit-logs';
import { formatDocumentAuditLogAction } from './document-audit-logs';

const i18n = setupI18n({ locale: 'en', messages: { en: {} } });
const recipientLog = (userId?: number | null) =>
  ZDocumentAuditLogSchema.parse({
    id: 'demonstrative-event',
    envelopeId: 'demonstrative-document',
    createdAt: new Date('2026-11-17T15:57:40Z'),
    type: 'DOCUMENT_RECIPIENT_COMPLETED',
    name: 'Demonstrative signer',
    userId,
    data: {
      recipientId: 1,
      recipientName: 'Demonstrative signer',
      recipientEmail: 'person@example.test',
      recipientRole: 'SIGNER',
    },
  });

describe('audit descriptions without a viewing user', () => {
  it.each([undefined, null, 7])('keeps third person when event userId is %s and no viewer is provided', (userId) => {
    expect(formatDocumentAuditLogAction(i18n, recipientLog(userId)).description).toBe(
      'Demonstrative signer signed the document',
    );
  });

  it('keeps second person in the UI for an explicitly matching viewer', () => {
    expect(formatDocumentAuditLogAction(i18n, recipientLog(7), 7).description).toBe('You signed the document');
    expect(formatDocumentAuditLogAction(i18n, recipientLog(7), 8).description).toBe(
      'Demonstrative signer signed the document',
    );
  });
});
