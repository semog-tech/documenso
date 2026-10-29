import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSemogPdfReader } from './initial-pdf';
import {
  createSemogPartialSealFixture,
  SEMOG_REPOSITORY_ROOT,
  SEMOG_STAMP_FONT_PATH,
} from './partial-seal-test-fixtures';
import { createSemogPrismaSealer } from './sealing';

type Fixture = Awaited<ReturnType<typeof createSemogPartialSealFixture>>;
const pageTexts = async (bytes: Uint8Array) => {
  const document = await getDocument({ data: new Uint8Array(bytes) }).promise;
  const texts: string[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const content = await (await document.getPage(number)).getTextContent();
    texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
  }
  await document.destroy();
  return texts;
};
const signEveryone = (fixture: Fixture) => {
  for (const recipient of fixture.envelope.recipients) {
    Object.assign(recipient, { signingStatus: 'SIGNED', signedAt: new Date('2026-10-28T13:00:00.000Z') });
  }
  for (const field of fixture.envelope.fields) {
    Object.assign(field, {
      inserted: true,
      customText: field.type === 'TEXT' ? `VALOR-${field.recipientId}` : '',
      signature:
        field.type === 'SIGNATURE'
          ? {
              id: field.recipientId,
              fieldId: field.id,
              recipientId: field.recipientId,
              created: new Date(),
              signatureImageAsBase64: null,
              typedSignature: `Assinante ${field.recipientId}`,
            }
          : null,
    });
  }
};
const seal = async (fixture: Fixture) => {
  const sealer = createSemogPrismaSealer({
    enabled: true,
    client: fixture.store.client,
    readPdf: createSemogPdfReader(),
    signer: fixture.signer,
    rejectionFont: readFileSync(SEMOG_STAMP_FONT_PATH),
    getDocumentI18n: fixture.getDocumentI18n,
  });
  const result = await sealer.seal(fixture.actor, 'env_partial');
  const [data] = [...fixture.store.state.documentData.values()];
  return { result, bytes: Buffer.from(data.data, 'base64') };
};

/** Protects the native completion/rejection output against the decorate() refactor shared with the partial seal. */
describe('Semog native seal through decorateSemogPdf', () => {
  beforeAll(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(resolve(SEMOG_REPOSITORY_ROOT, 'apps/remix'));
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });
  it('completes: every field, no stamp, native reason, envelope COMPLETED with a new document', async () => {
    const fixture = await createSemogPartialSealFixture({ nativeSeal: true });
    signEveryone(fixture);
    const { result, bytes } = await seal(fixture);
    expect(result).toEqual({ envelopeId: 'env_partial', documentoConcluido: true });
    const texts = await pageTexts(bytes);
    for (const id of [1, 2, 3, 4, 5]) {
      expect(texts[0]).toContain(`VALOR-${id}`);
    }
    expect(texts.join('\n')).not.toContain('SELO PARCIAL');
    expect(texts.join('\n')).not.toContain('DOCUMENT REJECTED');
    const contents = bytes.toString('latin1');
    expect(contents).toContain('/Reason (Signed by Documenso)');
    expect(contents).toContain('/ETSI.CAdES.detached');
    expect(fixture.store.native.envelopeUpdates).toMatchObject([{ data: { status: 'COMPLETED' } }]);
    expect(fixture.store.native.itemUpdates).toHaveLength(1);
    expect(fixture.store.native.audits).toMatchObject([{ data: { type: 'DOCUMENT_COMPLETED' } }]);
    expect(fixture.store.native.statements.some((text) => text.includes('INSERT INTO semog_bridge.outbox'))).toBe(true);
  }, 60000);
  it('rejects: stamps only the original pages, keeps signed fields, envelope REJECTED', async () => {
    const fixture = await createSemogPartialSealFixture({ nativeSeal: true });
    Object.assign(fixture.envelope.recipients[3], { signingStatus: 'REJECTED', rejectionReason: 'Discordo' });
    const { result, bytes } = await seal(fixture);
    expect(result).toEqual({ envelopeId: 'env_partial', documentoConcluido: false });
    const texts = await pageTexts(bytes);
    expect(texts.length).toBeGreaterThan(2);
    expect(texts[0]).toContain('DOCUMENT REJECTED');
    expect(texts[1]).toContain('DOCUMENT REJECTED');
    for (const text of texts.slice(2)) {
      expect(text).not.toContain('DOCUMENT REJECTED');
    }
    expect(texts[0]).toContain('VALOR-1');
    expect(texts[0]).not.toContain('NAO-ASSINOU');
    expect(texts.join('\n')).not.toContain('SELO PARCIAL');
    expect(fixture.store.native.envelopeUpdates).toMatchObject([{ data: { status: 'REJECTED' } }]);
  }, 60000);
});
