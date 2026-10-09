import { PDFDocument } from '@cantoo/pdf-lib';
import { DocumentDataType } from '@prisma/client';
import { base64 } from '@scure/base';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { SemogEnvelopeSnapshotSource } from './contract';

export type SemogPdfSource = { documentDataId: string; type: DocumentDataType; data: string };
export type SemogPdfReader = (input: SemogPdfSource) => Promise<Uint8Array>;
/** S3 access is injected explicitly; inline formats use the native get-file.server codec. */
export const createSemogPdfReader =
  (readS3?: (key: string) => Promise<Uint8Array>): SemogPdfReader =>
  async (source) => {
    if (source.type === DocumentDataType.BYTES) {
      return new TextEncoder().encode(source.data);
    }
    if (source.type === DocumentDataType.BYTES_64) {
      return base64.decode(source.data);
    }
    if (!readS3) {
      throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
    }
    return await readS3(source.data);
  };
export const validateSemogPdf = async (pdf: Uint8Array, fields: SemogEnvelopeSnapshotSource['fields']) => {
  if (pdf.byteLength > 50 * 1024 * 1024) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 400 });
  }
  const document = await PDFDocument.load(pdf);
  if (document.getPageCount() === 0 || fields.some((field) => field.page > document.getPageCount())) {
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
