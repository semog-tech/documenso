import type { SemogContactService } from './contact-service';
import { semogDraftJsonResponse } from './draft-http';
import {
  decodeSemogEnvelopeId,
  readSemogBearer,
  readSemogJsonRequest,
  semogRouteErrorResponse,
} from './envelope-route-http';

/** Prefix the host uses to dispatch here; anything else under it is answered 404 by this handler. */
export const SEMOG_CONTACT_PREFIX = /^\/api\/semog\/v1\/envelopes\/[^/]+\/contatos(?:\/|$)/;
const createPath = /^\/api\/semog\/v1\/envelopes\/([^/]+)\/contatos$/;
const MAX_BODY_BYTES = 4096;

/** Separate opt-in handler with the bridge transport: server-only Bearer, team scope, sanitized errors. */
export const createSemogContactHandler =
  (service: Pick<SemogContactService, 'authenticate' | 'create'>) => async (request: Request) => {
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
