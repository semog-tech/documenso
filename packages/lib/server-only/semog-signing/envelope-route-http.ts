import { z } from 'zod';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { readSemogBoundedJsonBody, semogDraftJsonResponse } from './draft-http';
import { readSemogRefusal } from './route-refusal';
import { semogError } from './service-validation';

/** Shared by the per-envelope bridge routes (selos-parciais, prorrogacoes): same transport and errors. */
export const decodeSemogEnvelopeId = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw semogError(AppErrorCode.INVALID_REQUEST, 400);
  }
};
export const readSemogBearer = (request: Request) => {
  const bearer = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '');
  if (!bearer) {
    throw semogError(AppErrorCode.UNAUTHORIZED, 401);
  }
  return bearer[1];
};
export const readSemogJsonRequest = async (request: Request, maximum: number) => {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
  return await readSemogBoundedJsonBody(request, maximum);
};
export const semogRouteErrorResponse = (error: unknown) => {
  const status =
    error instanceof z.ZodError
      ? 400
      : error instanceof AppError && [400, 401, 404, 409, 413, 503].includes(error.statusCode ?? 0)
        ? (error.statusCode ?? 503)
        : 503;
  const refusal = status === 409 ? readSemogRefusal(error) : null;
  return semogDraftJsonResponse(
    { error: status === 503 ? 'Ponte indisponível.' : 'Solicitação não autorizada ou inválida.', ...refusal },
    status,
  );
};
