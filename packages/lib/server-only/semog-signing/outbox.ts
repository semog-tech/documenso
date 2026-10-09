import { SEND_DOCUMENT_CANCELLED_EMAILS_JOB_DEFINITION } from '@documenso/lib/jobs/definitions/emails/send-document-cancelled-emails';
import { SEND_DOCUMENT_PENDING_EMAIL_JOB_DEFINITION } from '@documenso/lib/jobs/definitions/emails/send-document-pending-email';
import { SEND_RECIPIENT_SIGNED_EMAIL_JOB_DEFINITION } from '@documenso/lib/jobs/definitions/emails/send-recipient-signed-email';
import { SEND_SIGNING_REJECTION_EMAILS_JOB_DEFINITION } from '@documenso/lib/jobs/definitions/emails/send-rejection-emails';
import { SEND_SIGNING_EMAIL_JOB_DEFINITION } from '@documenso/lib/jobs/definitions/emails/send-signing-email';
import { SEAL_DOCUMENT_JOB_DEFINITION } from '@documenso/lib/jobs/definitions/internal/seal-document';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError, AppErrorCode } from '../../errors/app-error';

const jobSchemas = {
  'internal.seal-document': SEAL_DOCUMENT_JOB_DEFINITION.trigger.schema,
  'send.recipient.signed.email': SEND_RECIPIENT_SIGNED_EMAIL_JOB_DEFINITION.trigger.schema,
  'send.document.pending.email': SEND_DOCUMENT_PENDING_EMAIL_JOB_DEFINITION.trigger.schema,
  'send.signing.requested.email': SEND_SIGNING_EMAIL_JOB_DEFINITION.trigger.schema,
  'send.signing.rejected.emails': SEND_SIGNING_REJECTION_EMAILS_JOB_DEFINITION.trigger.schema,
  'send.document.cancelled.emails': SEND_DOCUMENT_CANCELLED_EMAILS_JOB_DEFINITION.trigger.schema,
};

const effectSchema = z.object({
  id: z.string().min(1),
  chaveOperacao: z.string().uuid(),
  envelopeId: z.string().min(1),
  kind: z.enum(['job', 'seal', 'webhook']),
  payload: z.record(z.unknown()),
  lease: z.string().uuid(),
  estado: z.literal('leased'),
  tentativa: z.number().int().positive(),
});
export type SemogOutboxEffect = z.infer<typeof effectSchema>;
type SqlPort = { $queryRaw: <T>(statement: Prisma.Sql) => Promise<T> };
type Dependencies = {
  enabled?: boolean;
  client: SqlPort;
  deliver?: (effect: SemogOutboxEffect) => Promise<void>;
  sealOnly?: boolean;
};
const acknowledge = async (client: SqlPort, effect: SemogOutboxEffect, success: boolean) =>
  client.$queryRaw(Prisma.sql`SELECT public.semog_signing_ack_effect(${effect.id},${effect.lease}::uuid,${success})`);

/** At-least-once delivery with durable idempotency IDs. A provider must honor effect.id on retry. */
export const createSemogOutboxWorker = (dependencies: Dependencies) => ({
  tick: async () => {
    if (dependencies.enabled !== true || !dependencies.deliver) {
      throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
    }
    const rows = await dependencies.client.$queryRaw<{ body: unknown }[]>(
      dependencies.sealOnly === true
        ? Prisma.sql`SELECT public.semog_signing_claim_seal_effect(120) body`
        : Prisma.sql`SELECT public.semog_signing_claim_effect(120) body`,
    );
    if (rows[0]?.body === null) {
      return { delivered: false, empty: true };
    }
    const effect = effectSchema.parse(rows[0]?.body);
    try {
      await dependencies.deliver(effect);
    } catch {
      await acknowledge(dependencies.client, effect, false);
      return { delivered: false, empty: false };
    }
    await acknowledge(dependencies.client, effect, true);
    return { delivered: true, empty: false };
  },
});

type JobTrigger = { id: string; name: string; payload: Record<string, unknown> };
type NativeEffects = {
  triggerJob: (job: JobTrigger) => Promise<void>;
  triggerWebhook: (event: { idempotencyKey: string; event: string; envelopeId: string }) => Promise<void>;
};
/** Adapters are injected by the trusted host; this module never imports global credentials or starts a worker. */
export const createSemogNativeEffectDeliverer = (native: NativeEffects) => (effect: SemogOutboxEffect) => {
  if (effect.kind === 'webhook') {
    const body = z
      .object({
        event: z.enum(['DOCUMENT_RECIPIENT_COMPLETED', 'DOCUMENT_SIGNED', 'DOCUMENT_COMPLETED', 'DOCUMENT_REJECTED']),
        envelopeId: z.string(),
      })
      .strict()
      .parse(effect.payload);
    if (body.envelopeId !== effect.envelopeId) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
    }
    return native.triggerWebhook({ idempotencyKey: effect.id, ...body });
  }
  const body = z
    .object({
      name: z.enum([
        'internal.seal-document',
        'send.recipient.signed.email',
        'send.document.pending.email',
        'send.signing.requested.email',
        'send.signing.rejected.emails',
        'send.document.cancelled.emails',
      ]),
      payload: z.record(z.unknown()),
    })
    .strict()
    .parse(effect.payload);
  if ((effect.kind === 'seal') !== (body.name === 'internal.seal-document')) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
  }
  const payload = jobSchemas[body.name].parse(body.payload);
  if ('envelopeId' in payload && payload.envelopeId !== effect.envelopeId) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
  }
  return native.triggerJob({ id: effect.id, ...body, payload });
};
