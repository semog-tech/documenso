import { createHash } from 'node:crypto';
import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { SemogSigningService } from './service';
import { semogError } from './service-validation';

const MAX_BODY_BYTES = 65536;
const response = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
const decodeBody = (bytes: Uint8Array) => {
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return body;
  } catch {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
};
const readBody = async (request: Request, maximum = MAX_BODY_BYTES) => {
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
    return decodeBody(Buffer.concat(chunks, size));
  } finally {
    reader.releaseLock();
  }
};
const errorResponse = (error: unknown) => {
  const status =
    error instanceof z.ZodError
      ? 400
      : error instanceof AppError && [400, 401, 404, 409, 413, 503].includes(error.statusCode ?? 0)
        ? (error.statusCode ?? 503)
        : error instanceof AppError && error.code === AppErrorCode.INVALID_REQUEST
          ? 409
          : 503;
  return response(
    { error: status === 503 ? 'Ponte indisponível.' : 'Solicitação não autorizada ou inválida.' },
    status,
  );
};

/** Native Request/Response adapter, deliberately not mounted in the Documenso router. */
export const createSemogSigningHandler = (service: SemogSigningService) => async (request: Request) => {
  try {
    const bearer = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '');
    const actor = await service.authenticate(bearer?.[1] ?? '');
    if (!bearer) {
      throw semogError(AppErrorCode.UNAUTHORIZED, 401);
    }
    const path = new URL(request.url).pathname;
    const pdfPath = /^\/api\/semog\/v1\/manifestacoes\/([^/]+)\/pdf$/.exec(path);
    if (request.method === 'GET' && pdfPath) {
      const key = z.string().uuid().parse(pdfPath[1]);
      const bytes = await service.pdf(actor, key);
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'attachment; filename="documento-assinado.pdf"',
          'X-Documento-SHA256': createHash('sha256').update(bytes).digest('hex'),
        },
      });
    }
    if (request.method === 'GET' && path.startsWith('/api/semog/v1/manifestacoes/')) {
      const key = z.string().uuid().parse(path.slice('/api/semog/v1/manifestacoes/'.length));
      return response(await service.get(actor, key), 200);
    }
    if (
      request.method !== 'POST' ||
      !['/api/semog/v1/inscricoes', '/api/semog/v1/manifestacoes', '/api/semog/v1/manifestacoes-visuais'].includes(path)
    ) {
      throw semogError(AppErrorCode.NOT_FOUND, 404);
    }
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw semogError(AppErrorCode.INVALID_BODY, 400);
    }
    const body: unknown = await readBody(
      request,
      path.endsWith('/manifestacoes-visuais') ? 8 * 1024 * 1024 : MAX_BODY_BYTES,
    );
    const result = path.endsWith('/inscricoes')
      ? await service.enroll(actor, body)
      : await service.reserve(actor, body);
    return response(result, 200);
  } catch (error) {
    return errorResponse(error);
  }
};
