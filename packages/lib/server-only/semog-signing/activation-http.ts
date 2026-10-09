import { z } from 'zod';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { SemogActivationService } from './activation-service';
import { readSemogBoundedJsonBody, semogDraftJsonResponse } from './draft-http';
import { semogError } from './service-validation';

export const SEMOG_ACTIVATION_PATH = '/api/semog/v1/envelopes-ativacao';
export const createSemogActivationHandler = (service: SemogActivationService) => async (request: Request) => {
  try {
    if (new URL(request.url).pathname !== SEMOG_ACTIVATION_PATH || request.method !== 'POST') {
      return semogDraftJsonResponse({ error: 'Rota indisponível.' }, 404);
    }
    const bearer = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '');
    if (!bearer) {
      throw semogError(AppErrorCode.UNAUTHORIZED, 401);
    }
    const actor = await service.authenticate(bearer[1]);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw semogError(AppErrorCode.INVALID_BODY, 400);
    }
    return semogDraftJsonResponse(await service.activate(actor, await readSemogBoundedJsonBody(request, 65536)), 200);
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
