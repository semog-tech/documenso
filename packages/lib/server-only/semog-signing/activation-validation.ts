import { createHash } from 'node:crypto';
import type { SemogActivationRequest } from './activation-contract';
import { activationConflict } from './activation-repository';
import type { SemogDraftResult } from './draft-contract';
import { SEMOG_DRAFT_MAX_PDF_BYTES } from './draft-contract';
import type { SemogDraftStructure } from './draft-structure';
import { hashSemogDraftStructure } from './draft-structure';
import type { SemogActor } from './service';

const pdfHash = (base64: string) => {
  if (
    base64.length > 4 * Math.ceil(SEMOG_DRAFT_MAX_PDF_BYTES / 3) ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  ) {
    throw activationConflict();
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > SEMOG_DRAFT_MAX_PDF_BYTES || bytes.toString('base64') !== base64) {
    throw activationConflict();
  }
  return createHash('sha256').update(bytes).digest('hex');
};
const validateIds = (envelope: SemogDraftStructure, draft: SemogDraftResult) => {
  const ids = (values: number[]) => [...values].sort((a, b) => a - b).join(',');
  if (
    envelope.envelopeItems.length !== 1 ||
    envelope.envelopeItems[0].id !== draft.documento.itemId ||
    ids(envelope.recipients.map((r) => r.id)) !== ids(draft.signatarios.map((r) => r.recipientId)) ||
    ids(envelope.fields.map((f) => f.id)) !== ids(draft.signatarios.flatMap((r) => r.campos.map((f) => f.fieldId)))
  ) {
    throw activationConflict();
  }
  const data = envelope.envelopeItems[0].documentData;
  if (
    data.type !== 'BYTES_64' ||
    pdfHash(data.data) !== draft.documento.sha256 ||
    pdfHash(data.initialData) !== draft.documento.sha256
  ) {
    throw activationConflict();
  }
};
const validateProgress = (envelope: SemogDraftStructure, input: SemogActivationRequest, replay: boolean) => {
  const expiry = new Date(input.expiraEm).getTime();
  if (
    envelope.recipients.some(
      (r) =>
        r.documentDeletedAt ||
        r.signingStatus === 'REJECTED' ||
        r.sendStatus !== 'NOT_SENT' ||
        r.sentAt !== null ||
        r.expirationNotifiedAt !== null ||
        r.nextReminderAt !== null ||
        (replay && r.expiresAt?.getTime() !== (r.role === 'CC' ? undefined : expiry)),
    )
  ) {
    throw activationConflict();
  }
  if (
    !replay &&
    (envelope.fields.some((f) => f.inserted || f.customText !== '' || f.signature !== null) ||
      envelope.recipients.some(
        (r) =>
          r.expiresAt !== null ||
          r.signedAt !== null ||
          r.readStatus !== 'NOT_OPENED' ||
          r.signingStatus !== (r.role === 'CC' ? 'SIGNED' : 'NOT_SIGNED'),
      ))
  ) {
    throw activationConflict();
  }
};
export const validateSemogActivationEnvelope = (input: {
  envelope: SemogDraftStructure;
  actor: SemogActor;
  request: SemogActivationRequest;
  draft: SemogDraftResult;
  structureHash: string;
  replay: boolean;
}) => {
  const { envelope, actor, request, draft, structureHash, replay } = input;
  if (
    envelope.userId !== actor.userId ||
    envelope.teamId !== actor.teamId ||
    envelope.externalId !== request.externalId ||
    envelope.deletedAt !== null ||
    envelope.completedAt !== null ||
    envelope.status !== (replay ? 'PENDING' : 'DRAFT') ||
    envelope.documentMeta.distributionMethod !== 'NONE' ||
    hashSemogDraftStructure(envelope) !== structureHash
  ) {
    throw activationConflict();
  }
  validateIds(envelope, draft);
  validateProgress(envelope, request, replay);
};
