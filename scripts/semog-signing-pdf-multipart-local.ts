/** Multipart experiment with one shared upload bottleneck and full-object confirmation. */
import { createHash, randomBytes } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { putSemogMultipartPdf } from '../packages/lib/server-only/semog-signing/pdf-store-multipart-candidate';
import { createSyntheticS3 } from './semog-signing-pdf-storage-fixture';

export const measureSemogMultipart = async (bytes: Buffer, latencyMs: number) => {
  const fixture = await createSyntheticS3(latencyMs);
  try {
    const sdk = new S3Client({
      ...fixture.settings,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    try {
      for (const concurrency of [1, 4, 5, 6] as const) {
        const key = `semog/pdf/${createHash('sha256').update(bytes).digest('hex')}.pdf`;
        const started = performance.now();
        if (concurrency === 1) {
          await sdk.send(
            new PutObjectCommand({
              Bucket: 'fixture',
              Key: key,
              Body: bytes,
              ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
            }),
          );
        } else {
          await putSemogMultipartPdf(sdk, {
            bucket: 'fixture',
            key,
            bytes,
            abortSignal: AbortSignal.timeout(40000),
            concurrency,
          });
        }
        const uploadedMs = performance.now() - started;
        if (concurrency === 1) {
          const head = await sdk.send(new HeadObjectCommand({ Bucket: 'fixture', Key: key, ChecksumMode: 'ENABLED' }));
          if (
            head.ChecksumSHA256 !== createHash('sha256').update(bytes).digest('base64') ||
            head.ContentLength !== bytes.byteLength
          ) {
            throw new Error('Single PUT confirmation failed');
          }
        } else {
          const object = await sdk.send(new GetObjectCommand({ Bucket: 'fixture', Key: key }));
          if (!object.Body) {
            throw new Error('Multipart confirmation returned no body');
          }
          const confirmed = await object.Body.transformToByteArray();
          if (
            createHash('sha256').update(confirmed).digest('hex') !== createHash('sha256').update(bytes).digest('hex')
          ) {
            throw new Error('Multipart full-object confirmation failed');
          }
        }
        if (!fixture.read(key)?.equals(bytes)) {
          throw new Error('Multipart fixture bytes differ');
        }
        console.log(
          JSON.stringify({
            rehearsal: 'pdf-storage-multipart',
            latencyMs,
            concurrency,
            bytes: bytes.byteLength,
            ms: Math.round((performance.now() - started) * 100) / 100,
            uploadedMs: Math.round(uploadedMs * 100) / 100,
            bytesVerified: true,
            confirmation: concurrency === 1 ? 'HEAD-full-object-sha256' : 'GET-full-object-sha256',
            model: 'shared-upload-bandwidth',
          }),
        );
      }
    } finally {
      sdk.destroy();
    }
  } finally {
    await fixture.close();
  }
};

if (process.argv.includes('--run')) {
  const bytes = randomBytes(55_207_556);
  for (const latencyMs of [1000, 2500, 4000]) {
    await measureSemogMultipart(bytes, latencyMs);
  }
}
