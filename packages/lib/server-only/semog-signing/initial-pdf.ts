import { PDFDocument } from '@cantoo/pdf-lib';
import { DocumentDataType } from '@prisma/client';
import { base64 } from '@scure/base';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { SemogEnvelopeStructureSource } from './contract';
import { SEMOG_DRAFT_MAX_PDF_BYTES } from './draft-contract';
import type { SemogPdfStore } from './pdf-store';
import { readSemogStoredPdf } from './pdf-store';

export type SemogPdfSource = { documentDataId: string; type: DocumentDataType; data: string };
export type SemogPdfReader = (input: SemogPdfSource) => Promise<Uint8Array>;
/** Object storage is injected explicitly; inline formats use the native get-file.server codec. */
export const createSemogPdfReader =
  (store?: SemogPdfStore): SemogPdfReader =>
  async (source) => {
    if (source.type === DocumentDataType.BYTES) {
      return new TextEncoder().encode(source.data);
    }
    if (source.type === DocumentDataType.BYTES_64) {
      return base64.decode(source.data);
    }
    if (!store) {
      throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
    }
    // Every object read is proven against the SHA-256 in its key, so a swapped object never reaches a signature.
    return await readSemogStoredPdf(store, source.data);
  };
/** The draft limit is the signing limit: a PDF the bridge accepts is a PDF it can sign. */
export const SEMOG_MAX_SIGNING_PDF_BYTES = SEMOG_DRAFT_MAX_PDF_BYTES;
/**
 * A seal appends certificate/audit pages and embeds each visual signature (up to 5 MiB PNG apiece), so the sealed
 * file is legitimately larger than its original. The margin covers several maximum-size signatures.
 */
export const SEMOG_MAX_SEALED_PDF_BYTES = SEMOG_MAX_SIGNING_PDF_BYTES + 32 * 1024 * 1024;
/** Full parse; returns the page count, which is a pure function of the bytes (and so of their SHA-256). */
export const inspectSemogPdf = async (pdf: Uint8Array, maximum = SEMOG_MAX_SIGNING_PDF_BYTES) => {
  if (pdf.byteLength > maximum) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 400 });
  }
  const pages = (await PDFDocument.load(pdf)).getPageCount();
  if (pages === 0) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
  }
  return pages;
};
export const validateSemogPdf = async (
  pdf: Uint8Array,
  fields: SemogEnvelopeStructureSource['fields'],
  maximum = SEMOG_MAX_SIGNING_PDF_BYTES,
) => {
  validateSemogFieldGeometry(await inspectSemogPdf(pdf, maximum), fields);
};
export const validateSemogFieldGeometry = (pages: number, fields: SemogEnvelopeStructureSource['fields']) => {
  if (fields.some((field) => field.page > pages)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
  }
  for (const field of fields) {
    const [x, y, width, height] = [field.positionX, field.positionY, field.width, field.height].map(Number);
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > 100 ||
      y + height > 100
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
    }
  }
};
