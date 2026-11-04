/** Loopback S3 fixture: actual SDK HTTP traffic, synthetic latency, no production access. */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Signer } from '@libpdf/core';
import type { PrismaClient } from '@prisma/client';
import { createSemogActivationService } from '../packages/lib/server-only/semog-signing/activation-service';
import type { SemogDocumentI18n } from '../packages/lib/server-only/semog-signing/document-pages';
import { createSemogDraftService } from '../packages/lib/server-only/semog-signing/draft-service';
import { createSemogHost } from '../packages/lib/server-only/semog-signing/host';
import { type SemogPdfStore, semogPdfKeyFor } from '../packages/lib/server-only/semog-signing/pdf-store';
import type { SemogS3Settings } from '../packages/lib/server-only/semog-signing/pdf-store-s3';
import { createSemogSigningRuntime } from '../packages/lib/server-only/semog-signing/runtime';
import type { SemogActor } from '../packages/lib/server-only/semog-signing/service';
import type { SemogStageObserver } from '../packages/lib/server-only/semog-signing/timing';

const hash = (bytes: Uint8Array, encoding: 'hex' | 'base64' = 'hex') =>
  createHash('sha256').update(bytes).digest(encoding);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Counts = { get: number; put: number; head: number; getBytes: number; putBytes: number };
const emptyCounts = (): Counts => ({ get: 0, put: 0, head: 0, getBytes: 0, putBytes: 0 });

export const createSyntheticS3 = async (
  latencyMs: number,
  bandwidth: 'shared' | 'independent' = 'shared',
  transferRequestMs = 50,
) => {
  let uploadReady = performance.now();
  const uploadDelay = async (size: number) => {
    const duration = (latencyMs * size) / 55_207_556;
    if (bandwidth === 'independent') {
      await delay(duration);
      return;
    }
    uploadReady = Math.max(performance.now(), uploadReady) + duration;
    await delay(Math.max(0, uploadReady - performance.now()));
  };
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Map<number, Buffer>>();
  let counts = emptyCounts();
  const receive = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const key = decodeURIComponent(url.pathname.replace(/^\/fixture\//, ''));
    if (url.searchParams.has('uploads')) {
      const id = randomUUID();
      uploads.set(id, new Map());
      await delay(50);
      response.setHeader('Content-Type', 'application/xml');
      response.end(
        `<InitiateMultipartUploadResult><Bucket>fixture</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
      return;
    }
    const uploadId = url.searchParams.get('uploadId');
    if (uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload) {
        response.writeHead(404).end();
        return;
      }
      if (request.method === 'DELETE') {
        uploads.delete(uploadId);
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'PUT') {
        const bytes = await receive(request);
        if (request.headers['x-amz-checksum-sha256'] !== hash(bytes, 'base64')) {
          response.writeHead(400).end('checksum mismatch');
          return;
        }
        await delay(transferRequestMs);
        await uploadDelay(bytes.byteLength);
        upload.set(Number(url.searchParams.get('partNumber')), bytes);
        response.setHeader('ETag', `"part-${url.searchParams.get('partNumber')}"`);
        response.setHeader('x-amz-checksum-sha256', hash(bytes, 'base64'));
        response.end();
        return;
      }
      await receive(request);
      const parts = [...upload.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes);
      const bytes = Buffer.concat(parts);
      const composite = `${hash(Buffer.concat(parts.map((part) => Buffer.from(hash(part, 'base64'), 'base64'))), 'base64')}-${parts.length}`;
      if (request.headers['x-amz-checksum-sha256'] !== composite) {
        response.writeHead(400).end('composite checksum mismatch');
        return;
      }
      objects.set(key, bytes);
      uploads.delete(uploadId);
      counts.put++;
      counts.putBytes += bytes.byteLength;
      await delay(50);
      response.setHeader('Content-Type', 'application/xml');
      response.end(
        `<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>${key}</Key><ETag>"multipart"</ETag><ChecksumSHA256>${composite}</ChecksumSHA256></CompleteMultipartUploadResult>`,
      );
      return;
    }
    if (request.method === 'PUT') {
      const bytes = await receive(request);
      if (request.headers['x-amz-checksum-sha256'] !== hash(bytes, 'base64')) {
        response.writeHead(400).end('checksum mismatch');
        return;
      }
      await delay(transferRequestMs);
      await uploadDelay(bytes.byteLength);
      objects.set(key, bytes);
      counts.put++;
      counts.putBytes += bytes.byteLength;
      response.setHeader('ETag', '"fixture"');
      response.end();
      return;
    }
    const bytes = objects.get(key);
    if (request.method === 'HEAD') {
      counts.head++;
      await delay(50);
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Length', bytes.byteLength);
      response.setHeader('x-amz-checksum-sha256', hash(bytes, 'base64'));
      response.end();
      return;
    }
    counts.get++;
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    counts.getBytes += bytes.byteLength;
    await delay(transferRequestMs + (latencyMs * bytes.byteLength) / 55_207_556);
    response.setHeader('Content-Length', bytes.byteLength);
    response.end(bytes);
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      console.error(error);
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Synthetic S3 did not bind a TCP address');
  }
  const settings: SemogS3Settings = {
    bucket: 'fixture',
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${address.port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
  };
  return {
    settings,
    reset: () => {
      counts = emptyCounts();
      objects.clear();
    },
    counts: () => ({ ...counts }),
    read: (key: string) => objects.get(key),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
};

type Flow = {
  client: PrismaClient;
  actor: SemogActor;
  signer: Signer;
  font: Uint8Array;
  getDocumentI18n: SemogDocumentI18n;
  bytes: Uint8Array;
  store: SemogPdfStore;
  observe: SemogStageObserver;
  measure: <T>(stage: string, run: () => Promise<T>) => Promise<T>;
};

/** Real service transactions, four enrollments/manifests, worker native CMS and bridge download. */
export const runPdfStorageFlow = async (context: Flow) => {
  const { client, actor, bytes, store: pdfStore, observe, measure } = context;
  const metadata = {
    operacaoId: randomUUID(),
    externalId: randomUUID(),
    versao: 1,
    ordemAssinatura: 'paralela',
    titulo: 'Ensaio sintético de armazenamento',
    arquivo: { nome: 'synthetic.pdf', sha256: hash(bytes), tamanho: bytes.byteLength },
    signatarios: [0, 1, 2, 3].map((index) => ({
      referencia: randomUUID(),
      nome: `Pessoa ${index}`,
      email: `person${index}@example.invalid`,
      ordem: 0,
      role: 'SIGNER',
      campos: [
        {
          referencia: randomUUID(),
          tipo: 'SIGNATURE',
          papel: 'assinatura',
          pagina: 1,
          x: 10,
          y: 10 + index * 20,
          largura: 30,
          altura: 8,
          obrigatorio: true,
        },
      ],
    })),
  };
  const draftService = createSemogDraftService({
    enabled: true,
    client,
    pdfStore,
    observe,
    authenticate: async () => actor,
  });
  const draft = await measure('draft', () => draftService.createBinary(actor, metadata, bytes));
  const deadline = new Date(Date.now() + 86400000).toISOString();
  const activation = createSemogActivationService({ enabled: true, client, pdfStore, authenticate: async () => actor });
  await measure('activation', () =>
    activation.activate(actor, {
      operacaoId: randomUUID(),
      rascunhoOperacaoId: metadata.operacaoId,
      externalId: metadata.externalId,
      envelopeId: draft.envelopeId,
      hashPdf: metadata.arquivo.sha256,
      expiraEm: deadline,
    }),
  );
  const runtime = createSemogSigningRuntime({ enabled: true, client, pdfStore, observe });
  const snapshots = [];
  for (const [index, recipient] of draft.signatarios.entries()) {
    snapshots.push(
      await measure(`enrollment.${index + 1}`, () =>
        runtime.service.enroll(actor, {
          envelopeId: draft.envelopeId,
          recipientId: recipient.recipientId,
          consentimento: 'Li e concordo.',
          expiraEm: deadline,
        }),
      ),
    );
  }
  let lastKey = '';
  for (const [index, recipient] of draft.signatarios.entries()) {
    lastKey = randomUUID();
    const snapshot = snapshots[index];
    const key = lastKey;
    const result = await measure(`manifestation.${index + 1}`, () =>
      runtime.service.reserve(actor, {
        chaveOperacao: key,
        envelopeId: draft.envelopeId,
        recipientId: recipient.recipientId,
        hashDocumento: snapshot.hashDocumento,
        hashConsentimento: snapshot.hashConsentimento,
        acao: 'assinar',
        motivo: null,
        campos: [{ fieldId: recipient.campos[0].fieldId, valor: metadata.signatarios[index].nome }],
        evidencias: {
          canal: 'email',
          identificacaoId: `synthetic-${index}`,
          confirmadoEm: new Date().toISOString(),
          ip: null,
          userAgent: null,
        },
      }),
    );
    if (result.situacao !== 'concluida') {
      throw new Error('Synthetic manifestation was not concluded');
    }
  }
  const host = createSemogHost({
    enabled: true,
    client,
    pdfStore,
    observe,
    signer: context.signer,
    rejectionFont: context.font,
    getDocumentI18n: context.getDocumentI18n,
    onError: (error) => {
      throw error;
    },
  });
  await measure('seal', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await host.tick();
      if ((await client.envelope.findUniqueOrThrow({ where: { id: draft.envelopeId } })).status === 'COMPLETED') {
        return;
      }
    }
    throw new Error('Synthetic seal did not complete');
  });
  const sealed = await measure('download', () => runtime.executor.pdf(actor, lastKey));
  const row = await client.envelopeItem.findFirstOrThrow({
    where: { envelopeId: draft.envelopeId },
    include: { documentData: true },
  });
  if (row.documentData.data !== semogPdfKeyFor(hash(sealed))) {
    throw new Error('Downloaded bytes differ from durable sealed object key');
  }
  return sealed;
};
