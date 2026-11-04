import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  type S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { semogPdfKeyHash } from './pdf-store';

/** Experiment only: SHA256 COMPOSITE is not the SHA256 of the complete PDF used by remote confirmation. */
export const putSemogMultipartPdf = async (
  client: S3Client,
  {
    bucket,
    key,
    bytes,
    abortSignal,
    concurrency = 4,
  }: { bucket: string; key: string; bytes: Uint8Array; abortSignal: AbortSignal; concurrency?: 4 | 5 | 6 },
) => {
  const hash = (value: Uint8Array) => createHash('sha256').update(value);
  if (semogPdfKeyHash(key) !== hash(bytes).digest('hex')) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
  }
  const options = { Bucket: bucket, Key: key };
  const created = await client.send(
    new CreateMultipartUploadCommand({ ...options, ContentType: 'application/pdf', ChecksumAlgorithm: 'SHA256' }),
    { abortSignal },
  );
  if (!created.UploadId) {
    throw new Error('Multipart upload returned no upload ID.');
  }
  const upload = { ...options, UploadId: created.UploadId };
  try {
    // Every non-final part meets S3's 5 MiB minimum; a 55 MB object has four to six equal parts.
    const partSize = Math.max(5 * 1024 * 1024, Math.ceil(bytes.byteLength / concurrency));
    const parts = Array.from({ length: Math.ceil(bytes.byteLength / partSize) }, (_, index) => {
      const body = bytes.subarray(index * partSize, (index + 1) * partSize);
      return { body, PartNumber: index + 1, ChecksumSHA256: hash(body).digest('base64') };
    });
    // Wait for all in-flight uploads before abort, preventing a late part from racing cleanup.
    const outcomes = await Promise.allSettled(
      parts.map(async ({ body, ...part }) => {
        const result = await client.send(new UploadPartCommand({ ...upload, ...part, Body: body }), { abortSignal });
        if (!result.ETag || result.ChecksumSHA256 !== part.ChecksumSHA256) {
          throw new Error('Multipart part checksum missing or divergent.');
        }
        return { ...part, ETag: result.ETag };
      }),
    );
    const completed = outcomes.map((outcome) => {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
      return outcome.value;
    });
    const composite = `${hash(Buffer.concat(parts.map((part) => Buffer.from(part.ChecksumSHA256, 'base64')))).digest('base64')}-${parts.length}`;
    const result = await client.send(
      new CompleteMultipartUploadCommand({
        ...upload,
        MultipartUpload: { Parts: completed },
        ChecksumSHA256: composite,
      }),
      { abortSignal },
    );
    if (result.ChecksumSHA256 !== composite) {
      throw new Error('Multipart object composite checksum missing or divergent.');
    }
  } catch (error) {
    try {
      // A separate bounded deadline still permits cleanup after the upload deadline expires.
      await client.send(new AbortMultipartUploadCommand(upload), { abortSignal: AbortSignal.timeout(5000) });
    } catch (abortError) {
      throw new AggregateError([error, abortError], 'Multipart upload and cleanup failed.');
    }
    throw error;
  }
};
