import { createHash } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { AppErrorCode } from '../../errors/app-error';
import { decodeSemogBase64 } from './base64';
import {
  SEMOG_DRAFT_MAX_PDF_BYTES,
  type SemogDraftInput,
  ZSemogDraftMetadata,
  ZSemogDraftRequest,
} from './draft-contract';
import { semogError } from './service-validation';
import { canonicalSemogJson } from './snapshot';
import { type SemogStageObserver, timeSemogStage } from './timing';

export const semogDraftMaximum = (maximum = SEMOG_DRAFT_MAX_PDF_BYTES) => {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > SEMOG_DRAFT_MAX_PDF_BYTES) {
    throw semogError(AppErrorCode.INVALID_REQUEST, 400);
  }
  return maximum;
};
/** Shared by both body formats: real PDF, fields inside its pages, and the request hash that drives idempotency. */
const finishDraft = async (input: SemogDraftInput, bytes: Uint8Array, observe?: SemogStageObserver) => {
  await timeSemogStage(observe, 'draft.pdf-load', async () => {
    try {
      const pdf = await PDFDocument.load(bytes);
      const count = pdf.getPageCount();
      if (
        count === 0 ||
        input.signatarios.some((recipient) => recipient.campos.some((field) => field.pagina > count))
      ) {
        throw semogError(AppErrorCode.INVALID_BODY, 400);
      }
    } catch {
      throw semogError(AppErrorCode.INVALID_BODY, 400);
    }
  });
  // Hash + byte length bind the exact bytes: a JSON and a binary body for the same PDF are the same operation.
  const hash = await timeSemogStage(observe, 'draft.request-hash', () =>
    createHash('sha256')
      .update(JSON.stringify(canonicalSemogJson(input)))
      .digest('hex'),
  );
  return { input, hash, bytes };
};
export const validateSemogDraft = async (body: unknown, maximum: number, observe?: SemogStageObserver) => {
  const parsed = await timeSemogStage(observe, 'draft.validate.schema', () => ZSemogDraftRequest.parse(body));
  const bytes = await timeSemogStage(
    observe,
    'draft.decode.base64',
    () =>
      decodeSemogBase64(parsed.arquivo.pdfBase64, {
        maximum: semogDraftMaximum(maximum),
        reject: (reason) => {
          if (reason === 'encoded-limit') {
            throw semogError(AppErrorCode.LIMIT_EXCEEDED, 413);
          }
          throw semogError(AppErrorCode.INVALID_BODY, 400);
        },
      }),
    (value) => ({ bytes: value.byteLength }),
  );
  await timeSemogStage(
    observe,
    'draft.hash',
    () => {
      if (createHash('sha256').update(bytes).digest('hex') !== parsed.arquivo.sha256) {
        throw semogError(AppErrorCode.INVALID_BODY, 400);
      }
      return bytes;
    },
    (value) => ({ bytes: value.byteLength }),
  );
  const { pdfBase64: _inline, ...arquivo } = parsed.arquivo;
  return await finishDraft({ ...parsed, arquivo: { ...arquivo, tamanho: bytes.length } }, bytes, observe);
};
/** Binary body: `metadados` declares SHA-256 and size; the `arquivo` part must be exactly those bytes. */
export const validateSemogBinaryDraft = async (
  metadata: unknown,
  bytes: Uint8Array,
  maximum: number,
  observe?: SemogStageObserver,
) => {
  const input = await timeSemogStage(observe, 'draft.validate.schema', () => ZSemogDraftMetadata.parse(metadata));
  if (input.arquivo.tamanho > semogDraftMaximum(maximum) || bytes.byteLength > maximum) {
    throw semogError(AppErrorCode.LIMIT_EXCEEDED, 413);
  }
  await timeSemogStage(
    observe,
    'draft.hash',
    () => {
      if (
        bytes.byteLength !== input.arquivo.tamanho ||
        createHash('sha256').update(bytes).digest('hex') !== input.arquivo.sha256
      ) {
        throw semogError(AppErrorCode.INVALID_BODY, 400);
      }
      return bytes;
    },
    (value) => ({ bytes: value.byteLength }),
  );
  return await finishDraft(input, bytes, observe);
};
