import type { PrismaClient } from '@prisma/client';
import { createSemogApiTokenAuthenticator } from './api-token';
import { createSemogDraftHandler } from './draft-http';
import { createSemogDraftService } from './draft-service';
import type { SemogPdfStore } from './pdf-store';
import type { SemogStageObserver } from './timing';

/** No .env, global Prisma, router mounting, distribution, workers or external transports. */
export const createSemogDraftRuntime = (dependencies: {
  observe?: SemogStageObserver;
  enabled?: boolean;
  client: PrismaClient;
  maximumPdfBytes?: number;
  pdfStore?: SemogPdfStore;
}) => {
  const service = createSemogDraftService({
    ...dependencies,
    authenticate: createSemogApiTokenAuthenticator(dependencies.client),
  });
  return { service, handler: createSemogDraftHandler(service, dependencies.observe) };
};
