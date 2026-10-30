import { z } from 'zod';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { semogDraftBodyLimit } from './draft-contract';
import { parseSemogDraftMultipart, semogDraftBinaryBodyLimit, semogMultipartBoundary } from './draft-multipart';
import type { SemogDraftService } from './draft-service';
import type { SemogActor } from './service';
import { semogError } from './service-validation';

export const SEMOG_DRAFT_PATH = '/api/semog/v1/envelopes-rascunho';
export const semogDraftJsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
const parseBody = (body: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
};
/** Stops reading — and cancels the upload — as soon as the body passes `maximum`, never buffering past it. */
export const readSemogBoundedBody = async (request: Request, maximum: number) => {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    throw semogError(AppErrorCode.LIMIT_EXCEEDED, 413);
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw semogError(AppErrorCode.LIMIT_EXCEEDED, 413);
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
};
export const readSemogBoundedJsonBody = async (request: Request, maximum: number) =>
  parseBody(await readSemogBoundedBody(request, maximum));
const mediaType = (request: Request) => request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
/** Legacy JSON (`arquivo.pdfBase64`) stays accepted while the semogapp moves to the binary multipart body. */
const createDraft = async (service: SemogDraftService, actor: SemogActor, request: Request) => {
  if (mediaType(request) === 'application/json') {
    const body = await readSemogBoundedJsonBody(request, semogDraftBodyLimit(service.maximumPdfBytes));
    return await service.create(actor, body);
  }
  const boundary = semogMultipartBoundary(request.headers.get('content-type'));
  if (boundary === null) {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
  const body = await readSemogBoundedBody(request, semogDraftBinaryBodyLimit(service.maximumPdfBytes));
  const { metadata, pdf } = parseSemogDraftMultipart(body, boundary);
  return await service.createBinary(actor, metadata, pdf);
};
/** Separate opt-in handler: never falls through to the native API or mounts itself. */
export const createSemogDraftHandler = (service: SemogDraftService) => async (request: Request) => {
  try {
    if (new URL(request.url).pathname !== SEMOG_DRAFT_PATH || request.method !== 'POST') {
      return semogDraftJsonResponse({ error: 'Rota indisponível.' }, 404);
    }
    const bearer = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '');
    if (!bearer) {
      throw semogError(AppErrorCode.UNAUTHORIZED, 401);
    }
    const actor = await service.authenticate(bearer[1]);
    return semogDraftJsonResponse(await createDraft(service, actor, request), 200);
  } catch (error) {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof AppError && [400, 401, 404, 409, 413, 503].includes(error.statusCode ?? 0)
          ? (error.statusCode ?? 503)
          : 503;
    return semogDraftJsonResponse(
      { error: status === 503 ? 'Ponte indisponível.' : 'Solicitação não autorizada ou inválida.' },
      status,
    );
  }
};
