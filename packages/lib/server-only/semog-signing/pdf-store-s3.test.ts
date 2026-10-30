import { createHash } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { semogPdfKeyFor } from './pdf-store';
import { createSemogS3PdfStore } from './pdf-store-s3';

type Behaviour = (request: IncomingMessage, response: ServerResponse) => void;
const servers: Server[] = [];
const fakeS3 = async (behaviour: Behaviour) => {
  const server = createServer(behaviour);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // listen(0) on TCP always yields AddressInfo
};
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
const bytes = new TextEncoder().encode('%PDF-1.7 prazo');
const key = semogPdfKeyFor(createHash('sha256').update(bytes).digest('hex'));
/** Production connect/headers values; only the shared operation deadline is shortened (6 s) to keep tests fast. */
const store = async (behaviour: Behaviour) =>
  createSemogS3PdfStore({
    bucket: 'local',
    endpoint: await fakeS3(behaviour),
    forcePathStyle: true,
    credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    timeouts: { connectMs: 5000, headersMs: 20000, operationMs: 6000 },
  });
const elapsed = async (operation: () => Promise<unknown>) => {
  const started = Date.now();
  await expect(operation()).rejects.toBeDefined();
  return Date.now() - started;
};

describe('Cliente S3 da ponte: um prazo único por operação', () => {
  it('HEAD lento (404 depois de 4 s) seguido de PUT mudo: a gravação inteira cai no prazo único, não 4 s + 6 s', async () => {
    const s3 = await store((request, response) => {
      if (request.method === 'HEAD') {
        setTimeout(() => response.writeHead(404).end(), 4000);
      }
      // PUT: reads the upload and never answers.
      request.resume();
    });
    const spent = await elapsed(() => s3.write(key, bytes));
    expect(spent).toBeGreaterThan(5500);
    expect(spent).toBeLessThan(9000);
  }, 30000);
  it('corpo que trava depois dos cabeçalhos: a leitura cai no prazo único (o de cabeçalhos já foi limpo)', async () => {
    const s3 = await store((_request, response) => {
      response.writeHead(200, { 'Content-Length': '100000', 'Content-Type': 'application/pdf' });
      response.write('%PDF-1.7 parcial');
    });
    const spent = await elapsed(() => s3.read(key));
    expect(spent).toBeGreaterThan(5500);
    expect(spent).toBeLessThan(9000);
  }, 30000);
  it('servidor que aceita a conexão e nunca responde: leitura e gravação caem no prazo', async () => {
    const s3 = await store((request) => request.resume());
    expect(await elapsed(() => s3.read(key))).toBeLessThan(9000);
    expect(await elapsed(() => s3.write(key, bytes))).toBeLessThan(9000);
  }, 30000);
  it('recusa gravar bytes sob uma chave que não é o hash deles, sem tocar a rede', async () => {
    const s3 = createSemogS3PdfStore({ bucket: 'local', endpoint: 'http://127.0.0.1:9', forcePathStyle: true });
    await expect(s3.write(key, new TextEncoder().encode('%PDF-1.7 outro'))).rejects.toMatchObject({ statusCode: 409 });
  });
});
