import type { PrismaClient } from '@prisma/client';
import { createSemogActivationHandler } from './activation-http';
import { createSemogActivationService } from './activation-service';
import { createSemogApiTokenAuthenticator } from './api-token';

/** Isolated opt-in composition: no environment loading or router mounting. */
export const createSemogActivationRuntime = (dependencies: {
  enabled?: boolean;
  client: PrismaClient;
  now?: () => Date;
}) => {
  const service = createSemogActivationService({
    ...dependencies,
    authenticate: createSemogApiTokenAuthenticator(dependencies.client),
  });
  return { service, handler: createSemogActivationHandler(service) };
};
