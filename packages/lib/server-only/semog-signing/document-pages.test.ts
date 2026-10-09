import { describe, expect, it } from 'vitest';
import { createSemogDocumentI18n } from './document-pages';

describe('native document catalogue composition', () => {
  it('keeps concurrent document languages isolated', async () => {
    const create = createSemogDocumentI18n(async (language) => ({ heading: [language] }));
    const [portuguese, english] = await Promise.all([create('pt-BR'), create('en')]);
    expect(portuguese._('heading')).toBe('pt-BR');
    expect(english._('heading')).toBe('en');
    expect(portuguese.locale).toBe('pt-BR');
  });

  it('propagates unavailable native catalogues instead of a fabricated certificate', async () => {
    const create = createSemogDocumentI18n(() => Promise.reject(new Error('catalogue unavailable')));
    await expect(create('pt-BR')).rejects.toThrow('catalogue unavailable');
  });
});
