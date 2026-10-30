import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSemogPdfReader } from './initial-pdf';
import {
  createSemogPartialSealFixture,
  SEMOG_REPOSITORY_ROOT,
  SEMOG_STAMP_FONT_PATH,
} from './partial-seal-test-fixtures';
import type { SemogPdfStore } from './pdf-store';
import { semogPdfKeyFor } from './pdf-store';
import { createSemogS3PdfStore } from './pdf-store-s3';
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

describe('Semog native seal with object storage (S3_PATH)', () => {
  beforeAll(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(resolve(SEMOG_REPOSITORY_ROOT, 'apps/remix'));
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });
  it('lê o original fora da transação e grava o selado no armazenamento, sob a chave do próprio hash', async () => {
    const fixture = await createSemogPartialSealFixture({ nativeSeal: true });
    signEveryone(fixture);
    const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const originalKey = semogPdfKeyFor(sha256(fixture.original));
    Object.assign(fixture.envelope.envelopeItems[0].documentData, {
      type: 'S3_PATH',
      data: originalKey,
      initialData: originalKey,
    });
    const objects = new Map<string, Uint8Array>([[originalKey, fixture.original]]);
    let inTransaction = false;
    const reads: string[] = [];
    const store: SemogPdfStore = {
      read: (key) => {
        reads.push(key);
        const bytes = objects.get(key);
        return inTransaction || !bytes
          ? Promise.reject(new Error('leitura dentro da transação'))
          : Promise.resolve(bytes);
      },
      write: (key, bytes) => {
        objects.set(key, bytes);
        return Promise.resolve();
      },
    };
    const sealer = createSemogPrismaSealer({
      enabled: true,
      client: {
        $transaction: async (fn, options) => {
          inTransaction = options?.isolationLevel === 'Serializable';
          try {
            return await fixture.store.client.$transaction(fn, options);
          } finally {
            inTransaction = false;
          }
        },
      },
      readPdf: createSemogPdfReader(store),
      pdfStore: store,
      signer: fixture.signer,
      rejectionFont: readFileSync(SEMOG_STAMP_FONT_PATH),
      getDocumentI18n: fixture.getDocumentI18n,
    });
    expect(await sealer.seal(fixture.actor, 'env_partial')).toEqual({
      envelopeId: 'env_partial',
      documentoConcluido: true,
    });
    const [sealed] = [...fixture.store.state.documentData.values()];
    const bytes = objects.get(sealed.data);
    expect(String(sealed.type)).toBe('S3_PATH');
    // The original stays referenced by its own key, never re-copied; the seal is a new content address.
    expect(sealed.initialData).toBe(originalKey);
    expect(bytes && sealed.data).toBe(bytes && semogPdfKeyFor(sha256(bytes)));
    expect(Buffer.from(bytes ?? []).toString('latin1')).toContain('/ETSI.CAdES.detached');
    // Original before the transaction, the sealed object right after the commit; none inside (the store rejects it).
    expect(reads).toEqual([originalKey, sealed.data]);
  }, 60000);
  it('selado que o armazenamento perdeu é regravado da memória logo depois do commit', async () => {
    const fixture = await createSemogPartialSealFixture({ nativeSeal: true });
    signEveryone(fixture);
    const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const originalKey = semogPdfKeyFor(sha256(fixture.original));
    Object.assign(fixture.envelope.envelopeItems[0].documentData, {
      type: 'S3_PATH',
      data: originalKey,
      initialData: originalKey,
    });
    const objects = new Map<string, Uint8Array>([[originalKey, fixture.original]]);
    let writes = 0;
    const store: SemogPdfStore = {
      read: (key) => {
        const bytes = objects.get(key);
        return bytes ? Promise.resolve(bytes) : Promise.reject(new Error('ausente'));
      },
      write: (key, bytes) => {
        // The first write is acknowledged but not kept: the loss only a read-back can see.
        if (writes++ > 0) {
          objects.set(key, bytes);
        }
        return Promise.resolve();
      },
    };
    const sealer = createSemogPrismaSealer({
      enabled: true,
      client: fixture.store.client,
      readPdf: createSemogPdfReader(store),
      pdfStore: store,
      signer: fixture.signer,
      rejectionFont: readFileSync(SEMOG_STAMP_FONT_PATH),
      getDocumentI18n: fixture.getDocumentI18n,
    });
    await sealer.seal(fixture.actor, 'env_partial');
    const [sealed] = [...fixture.store.state.documentData.values()];
    const bytes = objects.get(sealed.data);
    expect(writes).toBe(2);
    expect(bytes && semogPdfKeyFor(sha256(bytes))).toBe(sealed.data);
  }, 60000);
  it('upload do selado que não responde: a selagem falha dentro do prazo em vez de ficar pendurada', async () => {
    const fixture = await createSemogPartialSealFixture({ nativeSeal: true });
    signEveryone(fixture);
    const originalKey = semogPdfKeyFor(createHash('sha256').update(fixture.original).digest('hex'));
    Object.assign(fixture.envelope.envelopeItems[0].documentData, {
      type: 'S3_PATH',
      data: originalKey,
      initialData: originalKey,
    });
    const server = createServer(() => undefined);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const silent = createSemogS3PdfStore({
        bucket: 'local',
        // listen(0) on TCP always yields an AddressInfo.
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        forcePathStyle: true,
        credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
        timeouts: { connectMs: 5000, headersMs: 20000, operationMs: 3000 },
      });
      const store: SemogPdfStore = { read: () => Promise.resolve(fixture.original), write: silent.write };
      const sealer = createSemogPrismaSealer({
        enabled: true,
        client: fixture.store.client,
        readPdf: createSemogPdfReader(store),
        pdfStore: store,
        signer: fixture.signer,
        rejectionFont: readFileSync(SEMOG_STAMP_FONT_PATH),
        getDocumentI18n: fixture.getDocumentI18n,
      });
      const started = Date.now();
      await expect(sealer.seal(fixture.actor, 'env_partial')).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(20000);
      expect(fixture.store.native.envelopeUpdates).toHaveLength(0);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }, 60000);
});
