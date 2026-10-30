import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { SEMOG_MAX_SEALED_PDF_BYTES } from './initial-pdf';
import type { SemogPdfStore } from './pdf-store';
import { semogPdfKeyHash } from './pdf-store';
import type { SemogPurgeObjects } from './storage-purge';

/** The native upload transport's settings (NEXT_PRIVATE_UPLOAD_*), passed in by the host; nothing read here. */
export type SemogS3Settings = {
  bucket: string;
  endpoint?: string;
  region?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  timeouts?: Partial<SemogS3Timeouts>;
};
/**
 * The SDK default for each is 0 (wait forever). What @smithy/node-http-handler 4.4.12 really enforces:
 * - connectMs: establishing the connection;
 * - headersMs: until the response headers arrive — the handler clears it (and its socket timeout) once they do,
 *   so a body that stalls mid-download is NOT covered by it;
 * - operationMs: ONE deadline shared by every request of a read or write (HEAD, GET, PUT, retries), body included.
 *   This is the real guard. 40 s needs ~3.3 MB/s for the largest seal (132 MiB) and stays well under the seal
 *   transaction's 60 s, leaving room for rendering: a hung upload never outlives the transaction it belongs to.
 */
export type SemogS3Timeouts = { connectMs: number; headersMs: number; operationMs: number };
const DEFAULT_TIMEOUTS: SemogS3Timeouts = { connectMs: 5000, headersMs: 20000, operationMs: 40000 };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes);
const failure = (message: string) => new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409, message });
const isMissing = (error: unknown) =>
  error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey');

/**
 * Same client configuration as the native S3Provider, including its checksum settings for S3-compatible
 * providers such as R2, plus explicit timeouts. Direct GetObject/PutObject instead of presigned URLs.
 */
const connect = (settings: SemogS3Settings) => {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...settings.timeouts };
  const client = new S3Client({
    endpoint: settings.endpoint,
    forcePathStyle: settings.forcePathStyle === true,
    region: settings.region ?? 'us-east-1',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: settings.credentials,
    requestHandler: {
      connectionTimeout: timeouts.connectMs,
      requestTimeout: timeouts.headersMs,
      throwOnRequestTimeout: true,
    },
  });
  return { client, timeouts };
};
export const createSemogS3PdfStore = (settings: SemogS3Settings): SemogPdfStore => {
  const { client, timeouts } = connect(settings);
  const read = async (key: string, abortSignal: AbortSignal) => {
    const object = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: key }), { abortSignal });
    if (!object.Body || (object.ContentLength ?? 0) > SEMOG_MAX_SEALED_PDF_BYTES) {
      throw failure('Objeto ausente ou acima do teto do PDF selado.');
    }
    return await object.Body.transformToByteArray();
  };
  const exists = async (key: string, abortSignal: AbortSignal) => {
    try {
      await client.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: key }), { abortSignal });
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  };
  /** Content-addressed: an existing object is kept only if its bytes really hash to the key. */
  const alreadyStored = async (key: string, expected: string, abortSignal: AbortSignal) =>
    (await exists(key, abortSignal)) && sha256(await read(key, abortSignal)).digest('hex') === expected;
  const put = async (key: string, bytes: Uint8Array, abortSignal: AbortSignal) => {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: settings.bucket,
          Key: key,
          Body: bytes,
          ContentType: 'application/pdf',
          // R2 and MinIO verify it on arrival: corruption in transit is refused instead of stored.
          ChecksumSHA256: sha256(bytes).digest('base64'),
        }),
        { abortSignal },
      );
    } catch (error) {
      // A locked bucket refuses the rewrite of a damaged object: say so instead of carrying on with it.
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        statusCode: 409,
        message: `Gravação do PDF ${key} recusada pelo armazenamento: ${error instanceof Error ? error.name : 'erro'}.`,
      });
    }
  };
  return {
    read: (key) => read(key, AbortSignal.timeout(timeouts.operationMs)),
    write: async (key, bytes) => {
      const expected = semogPdfKeyHash(key);
      if (expected === null || sha256(bytes).digest('hex') !== expected) {
        throw failure('Chave do PDF não corresponde aos bytes.');
      }
      // One deadline for the whole write: HEAD, the GET of an existing object and the PUT share it.
      const deadline = AbortSignal.timeout(timeouts.operationMs);
      if (await alreadyStored(key, expected, deadline)) {
        return;
      }
      await put(key, bytes, deadline);
    },
  };
};

/**
 * The purge's extra calls on the same client configuration. Only bridge keys (semog/pdf/<sha256>.pdf) are ever
 * deleted; which key may go is decided by the database (storage_purge_begin), never here.
 */
export const createSemogS3PurgeObjects = (settings: SemogS3Settings): SemogPurgeObjects => {
  const { client, timeouts } = connect(settings);
  const lastModified = async (key: string) => {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(timeouts.operationMs),
      });
      if (!head.LastModified) {
        throw failure(`Objeto ${key} sem data de gravação.`);
      }
      return head.LastModified;
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  };
  const remove = async (key: string) => {
    if (semogPdfKeyHash(key) === null) {
      throw failure('Só PDFs da ponte são apagados pela purga.');
    }
    await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(timeouts.operationMs),
    });
  };
  return { ...createSemogS3PdfStore(settings), lastModified, remove };
};

/**
 * The native upload settings (NEXT_PUBLIC_UPLOAD_TRANSPORT, NEXT_PRIVATE_UPLOAD_*) through the caller's reader, so
 * this module still reads no environment itself. Undefined when the transport is not s3 (PDFs stay inline).
 */
export const semogS3SettingsFromEnv = (read: (name: string) => string | undefined): SemogS3Settings | undefined => {
  if (read('NEXT_PUBLIC_UPLOAD_TRANSPORT') !== 's3') {
    return undefined;
  }
  const bucket = read('NEXT_PRIVATE_UPLOAD_BUCKET');
  if (!bucket) {
    throw new Error('Semog object storage requires NEXT_PRIVATE_UPLOAD_BUCKET.');
  }
  const accessKeyId = read('NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID');
  const secretAccessKey = read('NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY');
  return {
    bucket,
    endpoint: read('NEXT_PRIVATE_UPLOAD_ENDPOINT') || undefined,
    region: read('NEXT_PRIVATE_UPLOAD_REGION') || undefined,
    forcePathStyle: read('NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE') === 'true',
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  };
};
