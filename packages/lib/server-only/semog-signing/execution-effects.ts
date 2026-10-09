import { Prisma } from '@prisma/client';
import { mapSecondaryIdToDocumentId } from '../../utils/envelope';
import type { SemogManifestation } from './service-validation';

type Effect = { id: string; kind: 'seal' | 'job' | 'webhook'; payload: Record<string, unknown> };
type EffectsInput = {
  envelopeId: string;
  secondaryId: string;
  ownerUserId: number;
  input: SemogManifestation;
  pending: { id: number; signingOrder: number | null }[];
  sequential: boolean;
};
const buildEffects = ({ envelopeId, secondaryId, ownerUserId, input, pending, sequential }: EffectsInput): Effect[] => {
  const documentId = mapSecondaryIdToDocumentId(secondaryId);
  const key = input.chaveOperacao;
  const metadata = {
    ...(input.evidencias.ip === null ? {} : { ipAddress: input.evidencias.ip }),
    ...(input.evidencias.userAgent === null ? {} : { userAgent: input.evidencias.userAgent }),
  };
  const effects: Effect[] = [];
  const job = (name: string, payload: Record<string, unknown>) =>
    effects.push({ id: `${key}-${name}`, kind: 'job', payload: { name, payload } });
  if (input.acao === 'recusar') {
    job('send.signing.rejected.emails', { documentId, recipientId: input.recipientId });
    job('send.document.cancelled.emails', {
      documentId,
      cancellationReason: input.motivo ?? 'Documento recusado.',
      requestMetadata: metadata,
    });
  } else {
    job('send.recipient.signed.email', { documentId, recipientId: input.recipientId });
    effects.push({
      id: `${key}-recipient-completed`,
      kind: 'webhook',
      payload: { event: 'DOCUMENT_RECIPIENT_COMPLETED', envelopeId },
    });
    effects.push({ id: `${key}-document-signed`, kind: 'webhook', payload: { event: 'DOCUMENT_SIGNED', envelopeId } });
    if (pending.length > 0) {
      job('send.document.pending.email', { envelopeId, recipientId: input.recipientId });
      if (sequential) {
        job('send.signing.requested.email', {
          userId: ownerUserId,
          documentId,
          recipientId: pending[0].id,
          requestMetadata: metadata,
        });
      }
    }
  }
  if (input.acao === 'recusar' || pending.length === 0) {
    effects.push({
      id: `${envelopeId}-seal`,
      kind: 'seal',
      payload: { name: 'internal.seal-document', payload: { documentId, sendEmail: false, requestMetadata: metadata } },
    });
  }
  return effects;
};

/** One durable row per effect, in the very same Prisma transaction as signing and evidence. */
export const recordSemogExecutionEffects = async (tx: Prisma.TransactionClient, input: EffectsInput) => {
  for (const effect of buildEffects(input)) {
    await tx.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.outbox(id,"chaveOperacao","envelopeId",kind,payload)
      VALUES(${effect.id},${input.input.chaveOperacao}::uuid,${input.envelopeId},${effect.kind},${JSON.stringify(effect.payload)}::jsonb)
      ON CONFLICT(id) DO NOTHING`);
  }
  if (input.sequential && input.input.acao === 'assinar' && input.pending.length > 0) {
    await tx.recipient.update({ where: { id: input.pending[0].id }, data: { sendStatus: 'SENT', sentAt: new Date() } });
  }
};
