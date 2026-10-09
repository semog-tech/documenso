import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSemogApiTokenAuthenticator } from '@documenso/lib/server-only/semog-signing/api-token';
import { createSemogDocumentI18n } from '@documenso/lib/server-only/semog-signing/document-pages';
import { createSemogHost } from '@documenso/lib/server-only/semog-signing/host';
import { createSemogHostRateLimit } from '@documenso/lib/server-only/semog-signing/host-rate-limit';
import { env } from '@documenso/lib/utils/env';
import { getTranslations } from '@documenso/lib/utils/i18n';
import { logger } from '@documenso/lib/utils/logger';
import { prisma } from '@documenso/prisma';
import { createLocalSigner } from '@documenso/signing/transports/local';
import { Prisma } from '@prisma/client';

export const semogHostRateLimit = createSemogHostRateLimit({
  enabled: () => env('SEMOG_SIGNING_ENABLED') === 'true',
  authenticate: createSemogApiTokenAuthenticator(prisma),
  consume: async (key) => {
    const bucket = new Date(Date.now() - (Date.now() % 60000));
    const counter = await prisma.rateLimit.upsert({
      where: { key_action_bucket: { key, action: 'api.semog.v1', bucket } },
      create: { key, action: 'api.semog.v1', bucket, count: 1 },
      update: { count: { increment: 1 } },
    });
    return { count: counter.count, reset: new Date(bucket.getTime() + 60000) };
  },
});

/** No development certificate fallback, implicit outbound delivery, or worker without opt-in. */
const initializeHost = async () => {
  if (env('SEMOG_SIGNING_ENABLED') !== 'true') {
    return null;
  }
  if (env('SEMOG_SIGNING_DELIVERY_ENABLED') === 'true') {
    throw new Error('Semog external delivery requires a reviewed host adapter.');
  }
  const certificate = env('NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH') || env('NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS');
  if (!certificate || (env('NEXT_PRIVATE_SIGNING_TRANSPORT') ?? 'local') !== 'local') {
    throw new Error('Semog host requires an explicit local signing certificate.');
  }
  const migration = await prisma.$queryRaw<{ ready: boolean }[]>(
    Prisma.sql`SELECT to_regprocedure('public.semog_signing_claim_seal_effect(integer)') IS NOT NULL ready`,
  );
  if (migration[0]?.ready !== true) {
    throw new Error('Semog host migration is required before enabling the bridge.');
  }
  const signer = await createLocalSigner({ buildChain: false });
  const getDocumentI18n = createSemogDocumentI18n(getTranslations);
  await getDocumentI18n('pt-BR');
  const host = createSemogHost({
    enabled: true,
    client: prisma,
    signer,
    getDocumentI18n,
    rejectionFont: await readFile(resolve('public/fonts/noto-sans.ttf')),
    onError: () => logger.error('Semog signing worker failed; inspect its durable outbox.'),
  });
  if (env('SEMOG_SIGNING_WORKER_ENABLED') === 'true') {
    host.start();
  }
  return host;
};
let initialized: ReturnType<typeof initializeHost> | undefined;
const getHost = () => {
  initialized ??= initializeHost();
  return initialized;
};
export const handleSemogHostRequest = async (request: Request, basePath = '') => {
  try {
    const host = await getHost();
    if (!host) {
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    const url = new URL(request.url);
    if (basePath) {
      url.pathname = url.pathname.slice(basePath.length);
    }
    return await host.handler(new Request(url, request));
  } catch {
    logger.error('Semog signing host unavailable; check configuration and migrations.');
    return new Response(JSON.stringify({ error: 'Ponte indisponível.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
};
export const startSemogHost = async () => {
  try {
    await getHost();
  } catch {
    logger.error('Semog signing host did not start; check configuration and migrations.');
  }
};
export const stopSemogHost = async () => {
  try {
    const host = initialized !== undefined ? await initialized : null;
    await host?.stop();
  } catch {
    logger.error('Semog signing host shutdown failed.');
  }
};
