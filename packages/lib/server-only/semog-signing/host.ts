import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { createSemogActivationRuntime } from './activation-runtime';
import { createSemogDraftRuntime } from './draft-runtime';
import type { SemogOutboxEffect } from './outbox';
import { createSemogSigningRuntime } from './runtime';

type Dependencies = Parameters<typeof createSemogSigningRuntime>[0] & {
  deliveryEnabled?: boolean;
  deliverExternal?: (effect: SemogOutboxEffect) => Promise<void>;
  intervalMs?: number;
  onError: (error: unknown) => void;
};
const denied = () => new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
const sealPayload = z
  .object({
    name: z.literal('internal.seal-document'),
    payload: z
      .object({
        documentId: z.number().int().positive(),
        sendEmail: z.literal(false),
        requestMetadata: z.record(z.unknown()),
      })
      .strict(),
  })
  .strict();
const readSealActor = async (client: PrismaClient, effect: SemogOutboxEffect) => {
  const rows = await client.$queryRaw<{ teamId: number; envelopeId: string; estado: string }[]>(
    Prisma.sql`SELECT "teamId","envelopeId",estado FROM semog_bridge.operations WHERE "chaveOperacao"=${effect.chaveOperacao}::uuid`,
  );
  const operation = rows[0];
  if (rows.length !== 1 || operation.envelopeId !== effect.envelopeId || operation.estado !== 'concluida') {
    throw denied();
  }
  const envelope = await client.envelope.findFirst({
    where: { id: effect.envelopeId, teamId: operation.teamId },
    select: { userId: true, secondaryId: true },
  });
  const payload = sealPayload.parse(effect.payload);
  if (!envelope || payload.payload.documentId !== mapSecondaryIdToDocumentId(envelope.secondaryId)) {
    throw denied();
  }
  return { teamId: operation.teamId, userId: envelope.userId };
};
/** Mounted host composition; external deliveries remain durable and pending until explicitly enabled. */
export const createSemogHost = (dependencies: Dependencies) => {
  if (dependencies.deliveryEnabled === true && !dependencies.deliverExternal) {
    throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
  }
  const runtime = createSemogSigningRuntime({
    ...dependencies,
    sealOnly: dependencies.deliveryEnabled !== true,
    deliver: async (effect) => {
      if (effect.kind !== 'seal') {
        if (dependencies.deliveryEnabled !== true || !dependencies.deliverExternal) {
          throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
        }
        await dependencies.deliverExternal(effect);
        return;
      }
      const actor = await readSealActor(dependencies.client, effect);
      const receipt = await runtime.executor.get(actor, effect.chaveOperacao);
      if (receipt.envelopeId !== effect.envelopeId || receipt.situacao !== 'concluida') {
        throw denied();
      }
      await runtime.sealer.seal(actor, effect.envelopeId);
    },
  });
  const draft = createSemogDraftRuntime(dependencies),
    activation = createSemogActivationRuntime(dependencies);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let polling = false;
  let stopped = true;
  const poll = async () => {
    try {
      const result = await runtime.outbox.tick();
      if (!result.delivered && !result.empty) {
        dependencies.onError(new AppError(AppErrorCode.UNKNOWN_ERROR, { message: 'Semog effect delivery failed.' }));
      }
    } catch (error) {
      dependencies.onError(error);
    } finally {
      polling = false;
      if (!stopped) {
        timer = setTimeout(schedule, dependencies.intervalMs ?? 1000);
        timer.unref();
      }
    }
  };
  const schedule = () => {
    if (polling) {
      return;
    }
    polling = true;
    running = poll();
  };
  return {
    runtime,
    handler: (request: Request) => {
      if (dependencies.enabled !== true) {
        return Promise.resolve(new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }));
      }
      const path = new URL(request.url).pathname;
      return path.endsWith('/envelopes-rascunho')
        ? draft.handler(request)
        : path.endsWith('/envelopes-ativacao')
          ? activation.handler(request)
          : runtime.handler(request);
    },
    tick: runtime.outbox.tick,
    start: () => {
      if (stopped && dependencies.enabled === true) {
        stopped = false;
        schedule();
      }
    },
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
};
