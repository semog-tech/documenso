import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { ZDocumentAuditLogTypeSchema } from '../../types/document-audit-logs';
import { eventoSemogPtBr, formatPdfDate, isSemogPdfPtBr, semogPdfAtivo, semogPdfI18n } from './semog-pdf-ptbr';

describe('bridge PDF presentation', () => {
  it('requires explicit metadata opt-in, preserving historical envelopes', () => {
    expect(isSemogPdfPtBr({ language: 'pt-BR', dateFormat: 'dd/MM/yyyy' })).toBe(false);
    expect(isSemogPdfPtBr({ language: 'en', dateFormat: 'dd/MM/yyyy HH:mm:ss' })).toBe(false);
    expect(isSemogPdfPtBr({ language: 'pt-BR', dateFormat: 'dd/MM/yyyy HH:mm:ss' })).toBe(true);
  });

  it('uses Fortaleza, numeric Brazilian dates and 24-hour time across UTC midnight', () => {
    const local = semogPdfI18n(setupI18n({ locale: 'pt-BR', messages: { 'pt-BR': {} } }));
    expect(formatPdfDate(new Date('2026-11-17T15:57:40Z'), local)).toBe('17/11/2026 12:57:40 (BRT)');
    expect(formatPdfDate(new Date('2026-11-17T01:02:03Z'), local)).toBe('16/11/2026 22:02:03 (BRT)');
  });

  it('keeps language and presentation isolated between simultaneous renders', async () => {
    const br = semogPdfI18n(setupI18n({ locale: 'pt-BR', messages: { 'pt-BR': { label: 'Assinado' } } }));
    const en = setupI18n({ locale: 'en', messages: { en: { label: 'Signed' } } });
    const results = await Promise.all([
      Promise.resolve().then(() => br._('label')),
      Promise.resolve().then(() => en._('label')),
    ]);
    expect(results).toEqual(['Assinado', 'Signed']);
    expect(semogPdfAtivo(en)).toBe(false);
    expect(semogPdfAtivo(br)).toBe(true);
  });

  it('translates every supported event without exposing technical enums', () => {
    for (const event of ZDocumentAuditLogTypeSchema.options) {
      expect(eventoSemogPtBr(event)).not.toBe('Evento registrado');
      expect(eventoSemogPtBr(event)).not.toContain('_');
    }
    expect(eventoSemogPtBr('FUTURE_EVENT')).toBe('Evento registrado');
  });
});
