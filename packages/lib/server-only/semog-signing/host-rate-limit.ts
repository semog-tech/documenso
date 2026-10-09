import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { SemogActor } from './service';

type Dependencies = {
  enabled: () => boolean;
  authenticate: (token: string) => Promise<SemogActor | null>;
  consume: (key: string) => Promise<{ count: number; reset: Date }>;
  maximum?: number;
};
/** Distributed token counter; forwarded headers never enter the key and DB failure is closed. */
export const createSemogHostRateLimit =
  (dependencies: Dependencies): MiddlewareHandler =>
  async (context, next) => {
    if (!dependencies.enabled()) {
      await next();
      return;
    }
    try {
      const bearer = /^Bearer (api_[a-z0-9]{16})$/.exec(context.req.header('authorization') ?? '');
      const token = bearer?.[1];
      const actor = token ? await dependencies.authenticate(token) : null;
      const key =
        actor && token ? `semog:token:${createHash('sha256').update(token).digest('hex')}` : 'semog:unauthorized';
      const result = await dependencies.consume(key);
      const maximum = dependencies.maximum ?? 1000;
      context.header('X-RateLimit-Limit', String(maximum));
      context.header('X-RateLimit-Remaining', String(Math.max(0, maximum - result.count)));
      context.header('Cache-Control', 'no-store');
      if (result.count > maximum) {
        context.header('Retry-After', String(Math.max(1, Math.ceil((result.reset.getTime() - Date.now()) / 1000))));
        return context.json({ error: 'Too many requests.' }, 429);
      }
    } catch {
      return context.json({ error: 'Ponte indisponível.' }, 503, { 'Cache-Control': 'no-store' });
    }
    await next();
  };
