import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { canonicalSemogJson } from './snapshot';

export const readSemogDraftStructure = (tx: Prisma.TransactionClient, id: string) =>
  tx.envelope.findUniqueOrThrow({
    where: { id },
    include: {
      documentMeta: true,
      envelopeItems: { include: { documentData: true }, orderBy: { id: 'asc' } },
      recipients: { orderBy: { id: 'asc' } },
      fields: { include: { signature: true }, orderBy: { id: 'asc' } },
      envelopeAttachments: { orderBy: { id: 'asc' } },
    },
  });
export type SemogDraftStructure = Awaited<ReturnType<typeof readSemogDraftStructure>>;

const recipientStructure = (recipient: SemogDraftStructure['recipients'][number]) => ({
  id: recipient.id,
  envelopeId: recipient.envelopeId,
  name: recipient.name,
  email: recipient.email,
  role: recipient.role,
  token: recipient.token,
  signingOrder: recipient.signingOrder,
  authOptions: recipient.authOptions,
});
const fieldStructure = (field: SemogDraftStructure['fields'][number]) => ({
  id: field.id,
  secondaryId: field.secondaryId,
  envelopeId: field.envelopeId,
  envelopeItemId: field.envelopeItemId,
  recipientId: field.recipientId,
  type: field.type,
  page: field.page,
  positionX: field.positionX.toString(),
  positionY: field.positionY.toString(),
  width: field.width.toString(),
  height: field.height.toString(),
  fieldMeta: field.fieldMeta,
});
/** Only immutable structure: signing progress is checked separately, never hashed as original geometry. */
export const hashSemogDraftStructure = (envelope: SemogDraftStructure) => {
  const { recipients, fields, envelopeItems, updatedAt, createdAt, status, completedAt, ...immutable } = envelope;
  const structure = {
    ...immutable,
    recipients: recipients.map(recipientStructure),
    fields: fields.map(fieldStructure),
    envelopeItems: envelopeItems.map(({ documentData, ...item }) => ({
      ...item,
      documentData: { id: documentData.id, type: documentData.type },
    })),
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalSemogJson(structure)))
    .digest('hex');
};
