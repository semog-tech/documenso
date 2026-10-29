import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { readSemogBoundedJsonBody, semogDraftJsonResponse } from './draft-http';
import type { SemogPartialSealService } from './partial-seal-service';
import { semogError } from './service-validation';

/** Prefix the host uses to dispatch here; anything else under it is answered 404 by this handler. */
export const SEMOG_PARTIAL_SEAL_PREFIX = /^\/api\/semog\/v1\/envelopes\/[^/]+\/selos-parciais(?:\/|$)/;
const createPath = /^\/api\/semog\/v1\/envelopes\/([^/]+)\/selos-parciais$/;
const pdfPath = /^\/api\/semog\/v1\/envelopes\/([^/]+)\/selos-parciais\/([1-9]\d{0,3})\/pdf$/;
const MAX_BODY_BYTES = 4096;

const errorResponse = (error: unknown) => {
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
};
const pdfResponse = (bytes: Uint8Array, rodada: number) =>
  new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="selo-parcial-rodada-${rodada}.pdf"`,
      'X-Documento-SHA256': createHash('sha256').update(bytes).digest('hex'),
    },
  });

/** Separate opt-in handler with the bridge transport: server-only Bearer, team scope, sanitized errors. */
export const createSemogPartialSealHandler =
  (service: Pick<SemogPartialSealService, 'authenticate' | 'create' | 'pdf'>) => async (request: Request) => {
    try {
      const path = new URL(request.url).pathname;
      const created = request.method === 'POST' ? createPath.exec(path) : null;
      const read = request.method === 'GET' ? pdfPath.exec(path) : null;
      if (!created && !read) {
        return semogDraftJsonResponse({ error: 'Rota indisponível.' }, 404);
      }
      const bearer = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '');
      if (!bearer) {
        throw semogError(AppErrorCode.UNAUTHORIZED, 401);
      }
      const actor = await service.authenticate(bearer[1]);
      if (read) {
        const rodada = Number(read[2]);
        return pdfResponse(await service.pdf(actor, decodeURIComponent(read[1]), rodada), rodada);
      }
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw semogError(AppErrorCode.INVALID_BODY, 400);
      }
      const body = await readSemogBoundedJsonBody(request, MAX_BODY_BYTES);
      return semogDraftJsonResponse(await service.create(actor, decodeURIComponent(created?.[1] ?? ''), body), 200);
    } catch (error) {
      return errorResponse(error);
    }
  };
