import type { Env, Hono, MiddlewareHandler } from 'hono';

/** Shared registration used by the real router and isolated HTTP process tests. */
export const mountSemogSigningRoutes = <E extends Env>(
  app: Hono<E>,
  dependencies: {
    handler: (request: Request, basePath: string) => Promise<Response>;
    basePath: string;
    rateLimit: MiddlewareHandler<E>;
  },
) => {
  app.use('/api/semog/v1/*', dependencies.rateLimit);
  app.all('/api/semog/v1/*', (c) => dependencies.handler(c.req.raw, dependencies.basePath));
};
