import { createHash } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { AppErrorCode } from '../../errors/app-error';
import {
  SEMOG_DRAFT_MAX_PDF_BYTES,
  type SemogDraftInput,
  type SemogDraftRequest,
  ZSemogDraftMetadata,
  ZSemogDraftRequest,
} from './draft-contract';
import { semogError } from './service-validation';
import { canonicalSemogJson } from './snapshot';

export const semogDraftMaximum = (maximum = SEMOG_DRAFT_MAX_PDF_BYTES) => {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > SEMOG_DRAFT_MAX_PDF_BYTES) {
    throw semogError(AppErrorCode.INVALID_REQUEST, 400);
  }
  return maximum;
};
const decodePdf = (input: SemogDraftRequest, maximum: number) => {
  const encoded = input.arquivo.pdfBase64;
  if (encoded.length > 4 * Math.ceil(maximum / 3)) {
    throw semogError(AppErrorCode.LIMIT_EXCEEDED, 413);
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length > maximum ||
    bytes.toString('base64') !== encoded ||
    createHash('sha256').update(bytes).digest('hex') !== input.arquivo.sha256
  ) {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
  return bytes;
};
/** Shared by both body formats: real PDF, fields inside its pages, and the request hash that drives idempotency. */
const finishDraft = async (input: SemogDraftInput, bytes: Uint8Array) => {
  try {
    const pdf = await PDFDocument.load(bytes);
    const count = pdf.getPageCount();
    if (count === 0 || input.signatarios.some((recipient) => recipient.campos.some((field) => field.pagina > count))) {
      throw semogError(AppErrorCode.INVALID_BODY, 400);
    }
  } catch {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
  // Hash + byte length bind the exact bytes: a JSON and a binary body for the same PDF are the same operation.
  const hash = createHash('sha256')
    .update(JSON.stringify(canonicalSemogJson(input)))
    .digest('hex');
  return { input, hash, bytes };
};
export const validateSemogDraft = async (body: unknown, maximum: number) => {
  const parsed = ZSemogDraftRequest.parse(body);
  const bytes = decodePdf(parsed, semogDraftMaximum(maximum));
  const { pdfBase64: _inline, ...arquivo } = parsed.arquivo;
  return await finishDraft({ ...parsed, arquivo: { ...arquivo, tamanho: bytes.length } }, bytes);
};
/** Binary body: `metadados` declares SHA-256 and size; the `arquivo` part must be exactly those bytes. */
export const validateSemogBinaryDraft = async (metadata: unknown, bytes: Uint8Array, maximum: number) => {
  const input = ZSemogDraftMetadata.parse(metadata);
  if (input.arquivo.tamanho > semogDraftMaximum(maximum) || bytes.byteLength > maximum) {
    throw semogError(AppErrorCode.LIMIT_EXCEEDED, 413);
  }
  if (
    bytes.byteLength !== input.arquivo.tamanho ||
    createHash('sha256').update(bytes).digest('hex') !== input.arquivo.sha256
  ) {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
  return await finishDraft(input, bytes);
};
