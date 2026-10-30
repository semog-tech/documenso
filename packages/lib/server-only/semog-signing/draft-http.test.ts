import { describe, expect, it, vi } from 'vitest';
import type { SemogDraftResult } from './draft-contract';
import { semogDraftBodyLimit } from './draft-contract';
import { createSemogDraftHandler, SEMOG_DRAFT_PATH } from './draft-http';
import { semogDraftBinaryBodyLimit } from './draft-multipart';

const fixture = () => {
  const result: SemogDraftResult = {
    operacaoId: '13e678a2-c5c2-46d4-a565-e04760dcd712',
    envelopeId: 'envelope_local',
    status: 'DRAFT',
    documento: { itemId: 'item_local', sha256: 'a'.repeat(64) },
    signatarios: [],
  };
  const service = {
    maximumPdfBytes: 20,
    authenticate: vi.fn(async () => ({ teamId: 1, userId: 1 })),
    create: vi.fn(async () => result),
    createBinary: vi.fn(async (_actor: unknown, _metadata: unknown, _pdf: Uint8Array) => result),
  };
  return { service, handler: createSemogDraftHandler(service) };
};
const request = (body: string, headers: Record<string, string> = {}) =>
  new Request(`https://bridge.invalid${SEMOG_DRAFT_PATH}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json', ...headers },
    body,
  });
describe('Semog draft HTTP adapter', () => {
  it('authenticates before malformed JSON and exposes no tokens/URLs', async () => {
    const { handler, service } = fixture();
    expect((await handler(request('{', { authorization: '' }))).status).toBe(401);
    expect(service.authenticate).not.toHaveBeenCalled();
    const result = await handler(request('{}'));
    expect(await result.json()).toEqual(await service.create());
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
  it('caps streaming body without Content-Length and before service/create', async () => {
    const { handler, service } = fixture();
    expect((await handler(request(JSON.stringify({ excess: 'x'.repeat(semogDraftBodyLimit(20)) })))).status).toBe(413);
    expect(service.create).not.toHaveBeenCalled();
    expect((await handler(request('{}', { 'content-length': '-1' }))).status).toBe(413);
  });
  it('rejects unknown routes, wrong type and sanitizes upstream failures', async () => {
    const { handler, service } = fixture();
    expect((await handler(new Request('https://bridge.invalid/api/v2/envelope/create'))).status).toBe(404);
    expect((await handler(request('{}', { 'content-type': 'text/plain' }))).status).toBe(400);
    service.create.mockRejectedValueOnce(new Error('private credential'));
    const result = await handler(request('{}'));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('private');
  });
});

const boundary = 'semog-teste-0123456789';
const CRLF = '\r\n';
type TestPart = { name: string; type: string; body: Uint8Array | string; filename?: string };
const multipart = (parts: TestPart[]) =>
  Buffer.concat([
    ...parts.flatMap((part) => [
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${part.name}"` +
          `${part.filename ? `; filename="${part.filename}"` : ''}${CRLF}Content-Type: ${part.type}${CRLF}${CRLF}`,
      ),
      Buffer.from(part.body),
      Buffer.from(CRLF),
    ]),
    Buffer.from(`--${boundary}--${CRLF}`),
  ]);
// `duplex` is required by Node for a streamed request body but missing from the DOM RequestInit type.
const binaryRequest = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request(`https://bridge.invalid${SEMOG_DRAFT_PATH}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers },
    body,
    duplex: 'half',
  } as RequestInit);
const metadata = { name: 'metadados', type: 'application/json', body: '{"titulo":"x"}' };
// Bytes with CRLF, dashes and the boundary minus one character: the parser must not cut the PDF there.
const pdf = new Uint8Array([...Buffer.from(`%PDF-1.7${CRLF}--${boundary.slice(0, -1)}${CRLF}`), 0, 255, 13, 10]);

describe('Semog draft HTTP adapter — corpo binário multipart', () => {
  it('entrega metadados e os bytes exatos do PDF ao serviço', async () => {
    const { handler, service } = fixture();
    const parts = [metadata, { name: 'arquivo', type: 'application/pdf', body: pdf, filename: 'doc.pdf' }];
    expect((await handler(binaryRequest(multipart(parts)))).status).toBe(200);
    expect(service.create).not.toHaveBeenCalled();
    const [, received, bytes] = service.createBinary.mock.calls[0];
    expect(received).toEqual({ titulo: 'x' });
    expect(Buffer.from(bytes).equals(Buffer.from(pdf))).toBe(true);
  });
  it('recusa parte ausente, fora de ordem, tipo errado ou sem boundary antes do serviço', async () => {
    const { handler, service } = fixture();
    const file = { name: 'arquivo', type: 'application/pdf', body: pdf };
    const bodies = [
      multipart([metadata]),
      multipart([file, metadata]),
      multipart([metadata, { ...file, type: 'application/octet-stream' }]),
      multipart([{ ...metadata, type: 'text/plain' }, file]),
      multipart([metadata, file, file]),
      Buffer.from('sem multipart'),
    ];
    for (const body of bodies) {
      expect((await handler(binaryRequest(body))).status).toBe(400);
    }
    const noBoundary = binaryRequest(multipart([metadata, file]), { 'content-type': 'multipart/form-data' });
    expect((await handler(noBoundary)).status).toBe(400);
    expect(service.createBinary).not.toHaveBeenCalled();
  });
  it('aborta o corpo acima do limite sem ler o resto do stream', async () => {
    const { handler, service } = fixture();
    const limit = semogDraftBinaryBodyLimit(service.maximumPdfBytes);
    const chunk = new Uint8Array(64 * 1024);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    expect((await handler(binaryRequest(stream))).status).toBe(413);
    // An endless stream: returning at all proves the cancel; at most a chunk or two past the limit was pulled.
    expect(pulled * chunk.byteLength).toBeLessThanOrEqual(limit + 2 * chunk.byteLength);
    expect(service.createBinary).not.toHaveBeenCalled();
    const declared = binaryRequest(new Uint8Array(1), { 'content-length': String(limit + 1) });
    expect((await handler(declared)).status).toBe(413);
  });
});
