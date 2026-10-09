import type { PrismaClient } from '@prisma/client';
import { createSemogApiTokenAuthenticator } from './api-token';
import { createSemogDraftHandler } from './draft-http';
import { createSemogDraftService } from './draft-service';

/** No .env, global Prisma, router mounting, distribution, workers or external transports. */
export const createSemogDraftRuntime = (dependencies: {
  enabled?: boolean;
  client: PrismaClient;
  maximumPdfBytes?: number;
}) => {
  const service = createSemogDraftService({
    ...dependencies,
    authenticate: createSemogApiTokenAuthenticator(dependencies.client),
  });
  return { service, handler: createSemogDraftHandler(service) };
};
