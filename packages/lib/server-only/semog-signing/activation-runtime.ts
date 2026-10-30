import type { PrismaClient } from '@prisma/client';
import { createSemogActivationHandler } from './activation-http';
import { createSemogActivationService } from './activation-service';
import { createSemogApiTokenAuthenticator } from './api-token';
import type { SemogPdfStore } from './pdf-store';

/** Isolated opt-in composition: no environment loading or router mounting. */
export const createSemogActivationRuntime = (dependencies: {
  enabled?: boolean;
  client: PrismaClient;
  now?: () => Date;
  pdfStore?: SemogPdfStore;
}) => {
  const service = createSemogActivationService({
    ...dependencies,
    authenticate: createSemogApiTokenAuthenticator(dependencies.client),
  });
  return { service, handler: createSemogActivationHandler(service) };
};
