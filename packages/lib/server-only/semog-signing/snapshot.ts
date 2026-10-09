import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AUTO_SIGNABLE_FIELD_TYPES } from '../../constants/autosign';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { ZFieldMetaNotOptionalSchema, ZSignatureFieldMeta, ZTextFieldMeta } from '../../types/field-meta';
import { fromCheckboxValue, toCheckboxValue } from '../../universal/field-checkbox';
import type { SemogEnvelopeSnapshotSource, SemogJson, SemogJsonObject, SemogSnapshot } from './contract';
import { ZSemogEnvelopeSnapshotSource } from './contract';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const invalid = () =>
  new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Envelope incompatível com a inscrição Semog.' });

export function canonicalSemogJson(value: unknown): SemogJson {
  return canonicalValue(value, new WeakSet(), 0);
}

function canonicalValue(value: unknown, ancestors: WeakSet<object>, depth: number): SemogJson {
  if (depth > 64) {
    throw invalid();
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
    throw invalid();
  }
  if (ancestors.has(value)) {
    throw invalid();
  }
  ancestors.add(value);
  const output = Array.isArray(value)
    ? value.map((entry) => canonicalValue(entry, ancestors, depth + 1))
    : canonicalObject(value, ancestors, depth);
  ancestors.delete(value);
  return output;
}

function canonicalObject(value: object, ancestors: WeakSet<object>, depth: number): SemogJsonObject {
  const output: SemogJsonObject = {};
  for (const key of Object.keys(value).sort()) {
    const entry: unknown = Reflect.get(value, key);
    if (entry === undefined) {
      throw invalid();
    }
    Object.defineProperty(output, key, { value: canonicalValue(entry, ancestors, depth + 1), enumerable: true });
  }
  return output;
}

function validateLinks(envelope: SemogEnvelopeSnapshotSource) {
  const recipients = new Set(envelope.recipients.map((item) => item.id));
  const fields = new Set(envelope.fields.map((item) => item.id));
  const item = envelope.envelopeItems[0];
  if (
    recipients.size !== envelope.recipients.length ||
    fields.size !== envelope.fields.length ||
    item.envelopeId !== envelope.id ||
    item.documentDataId !== item.documentData.id ||
    envelope.recipients.some((recipient) => recipient.envelopeId !== envelope.id) ||
    envelope.fields.some(
      (field) =>
        field.envelopeId !== envelope.id || field.envelopeItemId !== item.id || !recipients.has(field.recipientId),
    )
  ) {
    throw invalid();
  }
}

function validateRecipient(envelope: SemogEnvelopeSnapshotSource, recipientId: number, expiry: number) {
  const recipient = envelope.recipients.find((item) => item.id === recipientId);
  if (
    !recipient ||
    envelope.recipients.some((candidate) => candidate.signingStatus === 'REJECTED') ||
    recipient.role !== 'SIGNER' ||
    recipient.signingStatus !== 'NOT_SIGNED' ||
    recipient.documentDeletedAt !== null ||
    recipient.signedAt !== null ||
    (recipient.expiresAt !== null && Date.parse(recipient.expiresAt) < expiry)
  ) {
    throw invalid();
  }
  validateOrder(envelope, recipient.signingOrder);
}

function validateOrder(envelope: SemogEnvelopeSnapshotSource, ownOrder: number | null) {
  if (envelope.documentMeta.signingOrder === 'SEQUENTIAL') {
    const ordered = envelope.recipients.filter((item) => item.role !== 'CC');
    const orders = new Set(ordered.map((item) => item.signingOrder));
    if (
      ownOrder === null ||
      orders.size !== ordered.length ||
      orders.has(null) ||
      ordered.some(
        (item) =>
          item.signingOrder !== null &&
          ownOrder !== null &&
          item.signingOrder < ownOrder &&
          item.signingStatus !== 'SIGNED',
      )
    ) {
      throw invalid();
    }
  }
}

function validateFields(envelope: SemogEnvelopeSnapshotSource, recipientId: number) {
  const own = envelope.fields.filter((item) => item.recipientId === recipientId);
  if (!own.some((item) => item.type === 'SIGNATURE')) {
    throw invalid();
  }
  for (const field of envelope.fields) {
    validateFieldMetadata(field);
    if (field.recipientId !== recipientId) {
      continue;
    }
    const metadata =
      field.type === 'TEXT'
        ? ZTextFieldMeta.strict().safeParse(field.fieldMeta)
        : ZSignatureFieldMeta.strict().nullable().safeParse(field.fieldMeta);
    if (
      !['TEXT', 'SIGNATURE'].includes(field.type) ||
      !metadata.success ||
      metadata.data?.readOnly === true ||
      field.inserted
    ) {
      throw invalid();
    }
  }
}

function validateFieldMetadata(field: SemogEnvelopeSnapshotSource['fields'][number]) {
  if (field.fieldMeta === null) {
    return;
  }
  const metadata = ZFieldMetaNotOptionalSchema.safeParse(field.fieldMeta);
  if (
    !metadata.success ||
    metadata.data.type !== field.type.toLowerCase() ||
    typeof field.fieldMeta !== 'object' ||
    Object.keys(field.fieldMeta).some((key) => !Reflect.has(metadata.data, key))
  ) {
    throw invalid();
  }
}

function snapshotContent(
  envelope: SemogEnvelopeSnapshotSource,
  recipientId: number,
  bindings: SemogJsonObject,
): SemogJsonObject {
  const recipients = [...envelope.recipients]
    .sort((a, b) => a.id - b.id)
    .map((recipient) => snapshotRecipient(recipient, isParallelSignerProgress(envelope, recipient.id, recipientId)));
  const content = canonicalSemogJson({
    ...bindings,
    envelopeId: envelope.id,
    teamId: envelope.teamId,
    recipientId,
    title: envelope.title,
    type: envelope.type,
    signatureLevel: envelope.signatureLevel,
    useLegacyFieldInsertion: envelope.useLegacyFieldInsertion,
    authOptions: envelope.authOptions,
    documentMeta: envelope.documentMeta,
    item: snapshotItem(envelope.envelopeItems[0]),
    recipients,
    fields: [...envelope.fields]
      .sort((a, b) => a.id - b.id)
      .map((field) =>
        snapshotField(field, envelope, isParallelSignerProgress(envelope, field.recipientId, recipientId)),
      ),
  });
  if (content === null || Array.isArray(content) || typeof content !== 'object') {
    throw invalid();
  }
  return content;
}

const isParallelSignerProgress = (
  envelope: SemogEnvelopeSnapshotSource,
  fieldRecipientId: number,
  ownRecipientId: number,
) =>
  envelope.documentMeta.signingOrder === 'PARALLEL' &&
  fieldRecipientId !== ownRecipientId &&
  envelope.recipients.some((recipient) => recipient.id === fieldRecipientId && recipient.role === 'SIGNER');

const snapshotRecipient = (
  recipient: SemogEnvelopeSnapshotSource['recipients'][number],
  hasIndependentProgress: boolean,
) => {
  const { token, signingStatus, signedAt, ...structural } = recipient;
  const stable = { ...structural, tokenHash: sha256(token) };
  return hasIndependentProgress ? stable : { ...stable, signingStatus, signedAt };
};

const preservesPrefilledValue = (field: SemogEnvelopeSnapshotSource['fields'][number]) => {
  if (field.type === 'EMAIL') {
    return true;
  }
  if (AUTO_SIGNABLE_FIELD_TYPES.includes(field.type)) {
    return false;
  }
  if (field.fieldMeta === null) {
    return false;
  }
  const metadata = ZFieldMetaNotOptionalSchema.parse(field.fieldMeta);
  return metadata.readOnly === true;
};

const expectedPrefilledValue = (
  field: SemogEnvelopeSnapshotSource['fields'][number],
  envelope: SemogEnvelopeSnapshotSource,
): string | undefined => {
  if (field.type === 'EMAIL') {
    return envelope.recipients.find((recipient) => recipient.id === field.recipientId)?.email;
  }
  if (field.fieldMeta === null) {
    return undefined;
  }
  const metadata = ZFieldMetaNotOptionalSchema.parse(field.fieldMeta);
  if (metadata.type === 'text') {
    return metadata.text;
  }
  if (metadata.type === 'number') {
    return metadata.value;
  }
  if (metadata.type === 'dropdown') {
    return metadata.defaultValue;
  }
  if (metadata.type === 'radio' || metadata.type === 'checkbox') {
    const checked = metadata.values?.filter((value) => value.checked).map((value) => value.value) ?? [];
    return metadata.type === 'radio' ? checked[0] : toCheckboxValue(checked);
  }
  return undefined;
};

// Native signing updates inserted/customText. Freeze metadata, not writable default input.
// Readonly values normalize to the native validator's authorized value representation.
const snapshotField = (
  field: SemogEnvelopeSnapshotSource['fields'][number],
  envelope: SemogEnvelopeSnapshotSource,
  hasIndependentProgress: boolean,
) => {
  if (!hasIndependentProgress) {
    return field;
  }
  const { inserted: _inserted, customText, ...structural } = field;
  if (!preservesPrefilledValue(field)) {
    return structural;
  }
  const expected = expectedPrefilledValue(field, envelope);
  const actual = field.type === 'CHECKBOX' ? toCheckboxValue(fromCheckboxValue(customText)) : customText;
  if (expected !== undefined && actual !== expected && (field.inserted || customText !== '')) {
    throw invalid();
  }
  return { ...structural, customText: expected ?? customText };
};

function snapshotItem(item: SemogEnvelopeSnapshotSource['envelopeItems'][number]) {
  return {
    id: item.id,
    envelopeId: item.envelopeId,
    title: item.title,
    order: item.order,
    documentDataId: item.documentDataId,
    hashInitialData: sha256(item.documentData.initialData),
  };
}

type SnapshotInput = {
  teamId: number;
  envelope: unknown;
  pdf: Uint8Array;
  consentimento: string;
  recipientId: number;
  expiraEm: string;
};

function validateInput(input: SnapshotInput) {
  const parsed = ZSemogEnvelopeSnapshotSource.safeParse(input.envelope);
  const expiry = Date.parse(input.expiraEm);
  if (
    !parsed.success ||
    parsed.data.teamId !== input.teamId ||
    !Number.isSafeInteger(input.recipientId) ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    !z.string().datetime({ offset: true }).safeParse(input.expiraEm).success ||
    typeof input.consentimento !== 'string' ||
    input.consentimento.trim().length === 0 ||
    input.consentimento.length > 20_000 ||
    !(input.pdf instanceof Uint8Array) ||
    new TextDecoder().decode(input.pdf.subarray(0, 5)) !== '%PDF-'
  ) {
    throw invalid();
  }
  return { envelope: parsed.data, expiry };
}

/** Pure snapshot construction; callers must read envelope and INITIAL_DATA bytes on the trusted server. */
export function buildSemogSnapshot(input: SnapshotInput): SemogSnapshot {
  const { envelope, expiry } = validateInput(input);
  validateLinks(envelope);
  validateRecipient(envelope, input.recipientId, expiry);
  validateFields(envelope, input.recipientId);
  const expiraEm = new Date(expiry).toISOString();
  const hashDocumento = sha256(input.pdf);
  const hashConsentimento = sha256(input.consentimento);
  const conteudo = snapshotContent(envelope, input.recipientId, {
    hashDocumento,
    hashConsentimento,
    expiraEm,
    consentimento: input.consentimento,
  });
  return {
    id: randomUUID(),
    teamId: input.teamId,
    envelopeId: envelope.id,
    recipientId: input.recipientId,
    hashDocumento,
    hashConsentimento,
    hashSnapshot: sha256(JSON.stringify(conteudo)),
    expiraEm,
    conteudo,
  };
}
