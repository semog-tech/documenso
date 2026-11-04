import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSemogPdfReader } from './initial-pdf';
import { createSemogOutboxWorker } from './outbox';
import {
  createSemogPartialSealFixture,
  SEMOG_REPOSITORY_ROOT,
  SEMOG_STAMP_FONT_PATH,
} from './partial-seal-test-fixtures';
import type { SemogPdfStore } from './pdf-store';
import { semogPdfKeyFor } from './pdf-store';
import { createSemogS3PdfStore } from './pdf-store-s3';
import { createSemogSealNotifier, type SemogSealNotification } from './seal-notify';
import { createSemogPrismaSealer } from './sealing';
import type { SemogStageObserver, SemogStageTiming } from './timing';

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
const seal = async (
  fixture: Fixture,
  observe?: SemogStageObserver,
  notifyCompleted?: (notification: SemogSealNotification) => void,
) => {
  const sealer = createSemogPrismaSealer({
    enabled: true,
    observe,
    notifyCompleted,
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
    const timings: SemogStageTiming[] = [];
    let notificationStage: string | undefined;
    const notifyCompleted = vi.fn((_notification: SemogSealNotification) => {
      notificationStage = timings.at(-1)?.stage;
      // A broken optional adapter cannot change the seal result.
      throw new Error('optional notification unavailable');
    });
    const { result, bytes } = await seal(fixture, (timing) => timings.push(timing), notifyCompleted);
    expect(notifyCompleted).toHaveBeenCalledOnce();
    expect(notificationStage).toBe('seal.confirm');
    expect(notifyCompleted.mock.calls[0][0]).toEqual({ envelopeId: 'env_partial', completedAt: expect.any(String) });
    expect(fixture.store.native.envelopeUpdates).toMatchObject([
      { data: { completedAt: new Date(notifyCompleted.mock.calls[0][0].completedAt) } },
    ]);
    expect(timings.map((timing) => timing.stage)).toEqual([
      'seal.source',
      'seal.read',
      'seal.preread',
      'seal.lock',
      'seal.envelope',
      'seal.audit',
      'seal.original-load',
      'seal.render',
      'seal.pdf-load',
      'seal.decorate',
      'seal.pdf-save',
      'seal.normalize',
      'seal.signer',
      'seal.sign',
      'seal.storage',
      'seal.document-write',
      'seal.receipt-write',
      'seal.complete',
      'seal.transaction',
      'seal.confirm',
      'seal.total',
    ]);
    for (const timing of timings) {
      expect(Object.keys(timing).sort()).toEqual(['ms', 'ok', 'stage']);
      expect(timing.ok).toBe(true);
      expect(timing.ms).toBeGreaterThanOrEqual(0);
    }
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
  it('reports a signing failure without completing the envelope or masking the original error', async () => {
    const fixture = await createSemogPartialSealFixture({ nativeSeal: true });
    signEveryone(fixture);
    const original = new Error('injected signing failure');
    vi.spyOn(fixture.signer, 'sign').mockRejectedValueOnce(original);
    const timings: SemogStageTiming[] = [];
    const notifyCompleted = vi.fn();
    await expect(seal(fixture, (timing) => timings.push(timing), notifyCompleted)).rejects.toBe(original);
    expect(notifyCompleted).not.toHaveBeenCalled();
    expect(timings.filter((timing) => !timing.ok).map((timing) => timing.stage)).toEqual([
      'seal.signer',
      'seal.sign',
      'seal.transaction',
      'seal.total',
    ]);
    expect(timings.some((timing) => timing.stage === 'seal.complete')).toBe(false);
    expect(fixture.store.native.envelopeUpdates).toHaveLength(0);
  }, 60000);
  it('rejects: stamps only the original pages, keeps signed fields, envelope REJECTED', async () => {
    const fixture = await createSemogPartialSealFixture({ nativeSeal: true });
    Object.assign(fixture.envelope.recipients[3], { signingStatus: 'REJECTED', rejectionReason: 'Discordo' });
    const notifyCompleted = vi.fn();
    const { result, bytes } = await seal(fixture, undefined, notifyCompleted);
    expect(notifyCompleted).not.toHaveBeenCalled();
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
  it('does not await HTTP notification before the outbox ack or the next effect, and preserves committedAt on replay', async () => {
    const fixture = await createSemogPartialSealFixture({ nativeSeal: true });
    const completedAt = new Date('2026-11-04T20:11:00.000Z');
    Object.assign(fixture.envelope, { status: 'COMPLETED', completedAt });
    const requests: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push(Buffer.concat(chunks).toString());
        response.writeHead(503).end();
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const results: string[] = [];
    let inTransaction = false;
    const timings: SemogStageTiming[] = [];
    const notify = createSemogSealNotifier({
      // listen(0) on TCP returns AddressInfo.
      env: (key) =>
        key === 'SEMOG_SELAGEM_AVISO_URL'
          ? `http://127.0.0.1:${(server.address() as AddressInfo).port}/notify`
          : 'local-test-token',
      observe: (timing) => timings.push(timing),
      onResult: (result) => results.push(result.status),
    });
    const calledOutside: boolean[] = [];
    const sealer = createSemogPrismaSealer({
      enabled: true,
      signer: fixture.signer,
      client: {
        $transaction: async (fn, options) => {
          inTransaction = true;
          try {
            return await fixture.store.client.$transaction(fn, options);
          } finally {
            inTransaction = false;
          }
        },
      },
      readPdf: createSemogPdfReader(),
      observe: (timing) => timings.push(timing),
      notifyCompleted: (event) => {
        calledOutside.push(!inTransaction && timings.at(-1)?.stage === 'seal.confirm');
        notify?.(event);
      },
    });
    const effect = {
      id: 'seal-first',
      chaveOperacao: '11111111-1111-4111-8111-111111111111',
      envelopeId: 'env_partial',
      kind: 'seal',
      payload: {},
      lease: '22222222-2222-4222-8222-222222222222',
      estado: 'leased',
      tentativa: 1,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ body: effect }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ body: { ...effect, id: 'seal-next' } }])
      .mockResolvedValueOnce([]);
    const worker = createSemogOutboxWorker({
      enabled: true,
      client: { $queryRaw: query },
      deliver: async () => {
        await sealer.seal(fixture.actor, 'env_partial');
      },
    });
    try {
      expect(await worker.tick()).toEqual({ delivered: true, empty: false });
      expect(await worker.tick()).toEqual({ delivered: true, empty: false });
      // Both acks and the next seal completed while the HTTP requests are still pending.
      expect(results).toEqual([]);
      expect(query.mock.calls[1][0].values.at(-1)).toBe(true);
      expect(query.mock.calls[3][0].values.at(-1)).toBe(true);
      expect(calledOutside).toEqual([true, true]);
      await vi.waitFor(() => expect(results).toEqual(['http-503', 'http-503']));
      expect(requests).toHaveLength(4);
      expect(
        requests.every(
          (body) => body === JSON.stringify({ envelopeId: 'env_partial', completedAt: completedAt.toISOString() }),
        ),
      ).toBe(true);
      expect(fixture.store.native.envelopeUpdates).toHaveLength(0);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
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
  it('does not notify if the post-commit storage confirmation fails', async () => {
    const fixture = await createSemogPartialSealFixture({ nativeSeal: true });
    signEveryone(fixture);
    const originalKey = semogPdfKeyFor(createHash('sha256').update(fixture.original).digest('hex'));
    Object.assign(fixture.envelope.envelopeItems[0].documentData, {
      type: 'S3_PATH',
      data: originalKey,
      initialData: originalKey,
    });
    const notifyCompleted = vi.fn();
    const store: SemogPdfStore = {
      read: async () => fixture.original,
      write: async () => undefined,
      confirm: () => Promise.reject(new Error('storage confirmation unavailable')),
    };
    const sealer = createSemogPrismaSealer({
      enabled: true,
      client: fixture.store.client,
      readPdf: createSemogPdfReader(store),
      pdfStore: store,
      signer: fixture.signer,
      getDocumentI18n: fixture.getDocumentI18n,
      notifyCompleted,
    });
    await expect(sealer.seal(fixture.actor, 'env_partial')).rejects.toMatchObject({
      code: 'SEMOG_STORAGE_ENSURE_FAILED',
    });
    expect(notifyCompleted).not.toHaveBeenCalled();
    expect(fixture.store.native.envelopeUpdates).toMatchObject([{ data: { status: 'COMPLETED' } }]);
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
