import { semogDraftJsonResponse } from './draft-http';
import {
  decodeSemogEnvelopeId,
  readSemogBearer,
  readSemogJsonRequest,
  semogRouteErrorResponse,
} from './envelope-route-http';
import type { SemogExtensionService } from './extension-service';

/** Prefix the host uses to dispatch here; anything else under it is answered 404 by this handler. */
export const SEMOG_EXTENSION_PREFIX = /^\/api\/semog\/v1\/envelopes\/[^/]+\/prorrogacoes(?:\/|$)/;
const createPath = /^\/api\/semog\/v1\/envelopes\/([^/]+)\/prorrogacoes$/;
const MAX_BODY_BYTES = 8192;

/** Separate opt-in handler with the bridge transport: server-only Bearer, team scope, sanitized errors. */
export const createSemogExtensionHandler =
  (service: Pick<SemogExtensionService, 'authenticate' | 'create'>) => async (request: Request) => {
    try {
      const created = request.method === 'POST' ? createPath.exec(new URL(request.url).pathname) : null;
      if (!created) {
        return semogDraftJsonResponse({ error: 'Rota indisponível.' }, 404);
      }
      const actor = await service.authenticate(readSemogBearer(request));
      const body = await readSemogJsonRequest(request, MAX_BODY_BYTES);
      return semogDraftJsonResponse(await service.create(actor, decodeSemogEnvelopeId(created[1]), body), 200);
    } catch (error) {
      return semogRouteErrorResponse(error);
    }
  };
