import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { SemogManifestation } from './service-validation';

const invalid = () => new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 400 });
/** PNG decoding has the same 5 MiB/20M-pixel bounds as the trusted Semog upload adapter. */
export const validateSemogVisualSignature = async (input: SemogManifestation) => {
  const visual = input.assinaturaVisual;
  if (!visual) {
    return;
  }
  const bytes = Buffer.from(visual.pngBase64, 'base64');
  if (
    bytes.byteLength > 5 * 1024 * 1024 ||
    bytes.byteLength === 0 ||
    bytes.toString('base64') !== visual.pngBase64 ||
    createHash('sha256').update(bytes).digest('hex') !== visual.hash
  ) {
    throw invalid();
  }
  const decoder = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning' });
  const metadata = await decoder.metadata();
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) {
    throw invalid();
  }
  await decoder.raw().toBuffer();
};
export const semogVisualDataUrl = (input: NonNullable<SemogManifestation['assinaturaVisual']>) =>
  `data:image/png;base64,${input.pngBase64}`;
