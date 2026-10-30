import { createHash } from 'node:crypto';
import type { DocumentDataType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';

/** Object storage the host injects (the native S3/R2 transport). Absent: PDFs stay inline (BYTES_64). */
export type SemogPdfStore = {
  read: (key: string) => Promise<Uint8Array>;
  write: (key: string, bytes: Uint8Array) => Promise<void>;
};
export type SemogStoredPdf = { type: DocumentDataType; data: string };

const KEY = /^semog\/pdf\/([a-f0-9]{64})\.pdf$/;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const tampered = () => new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });

/**
 * Content-addressed key: the name is the SHA-256 of the bytes. Rewriting the same document is idempotent, and every
 * read proves the bytes against the name, so the key alone binds the content even though the bucket is mutable.
 */
export const semogPdfKeyFor = (hash: string) => `semog/pdf/${hash}.pdf`;
export const semogPdfKeyHash = (key: string) => KEY.exec(key)?.[1] ?? null;

export const readSemogStoredPdf = async (store: SemogPdfStore, key: string) => {
  const expected = semogPdfKeyHash(key);
  if (expected === null) {
    // Only bridge-written keys carry their own proof; any other object key is never trusted for signing.
    throw tampered();
  }
  const bytes = await store.read(key);
  if (sha256(bytes) !== expected) {
    throw tampered();
  }
  return bytes;
};

/**
 * Uploads under the content address; an upload left behind by a rolled-back transaction is just an unused copy.
 * `readBack` (default) reads the object again and proves it by content before anyone may reference it. Only the
 * seal skips it: its upload runs inside the seal transaction, where no PDF is read, and relies instead on the
 * SHA-256 checksum the bucket verifies on arrival — every later reader proves the bytes anyway.
 */
export const putSemogStoredPdf = async (
  store: SemogPdfStore,
  bytes: Uint8Array,
  options: { hash?: string; readBack?: boolean } = {},
) => {
  const key = semogPdfKeyFor(options.hash ?? sha256(bytes));
  await store.write(key, bytes);
  if (options.readBack !== false) {
    await readSemogStoredPdf(store, key);
  }
  return { type: 'S3_PATH', data: key } satisfies SemogStoredPdf;
};

/**
 * A derived PDF (seal, partial seal) follows its original's storage: one DocumentData row describes both columns
 * with a single type, so an inline original keeps an inline seal and an object-stored one gets an object seal.
 */
export const persistSemogDerivedPdf = async (
  store: SemogPdfStore | undefined,
  originalType: DocumentDataType,
  bytes: Uint8Array,
): Promise<SemogStoredPdf> => {
  if (originalType === 'BYTES_64') {
    return { type: 'BYTES_64', data: Buffer.from(bytes).toString('base64') };
  }
  if (originalType !== 'S3_PATH' || !store) {
    throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
  }
  return await putSemogStoredPdf(store, bytes, { readBack: false });
};

/**
 * A seal is written inside its transaction, where no PDF is read. The recorder remembers what was written there so
 * that, right after the commit, every object is read back and proven by content; one that does not match is
 * rewritten from the bytes still in memory. Only if that also fails does the caller get an error.
 */
export const recordSemogWrites = (store: SemogPdfStore | undefined) => {
  const written: { key: string; bytes: Uint8Array }[] = [];
  const recording: SemogPdfStore | undefined = store && {
    read: store.read,
    write: async (key, bytes) => {
      await store.write(key, bytes);
      written.push({ key, bytes });
    },
  };
  const confirm = async () => {
    if (!store) {
      return;
    }
    for (const { key, bytes } of written) {
      const proven = await readSemogStoredPdf(store, key).then(
        () => true,
        () => false,
      );
      if (!proven) {
        await store.write(key, bytes);
        await readSemogStoredPdf(store, key);
      }
    }
  };
  return { store: recording, confirm };
};
