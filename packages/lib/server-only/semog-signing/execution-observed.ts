import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { SemogPrismaTransactionRunner } from './execution';
import type { SemogPdfReader } from './initial-pdf';
import { SEMOG_MAX_SEALED_PDF_BYTES } from './initial-pdf';
import type { SemogActor } from './service';
import type { SemogStageObserver } from './timing';
import { timeSemogStage } from './timing';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ZSemogSealMetadata = z.object({
  type: z.enum(['BYTES', 'BYTES_64', 'S3_PATH']),
  hashInitialDataValue: hashSchema,
  hashDataValue: hashSchema,
  hashOriginal: hashSchema,
  bytes: z.number().int().positive(),
});

export const ZSemogSealReceipt = z.object({
  documentDataId: z.string(),
  hashPdf: hashSchema,
  metadata: ZSemogSealMetadata.optional(),
});

/** Only the sealed bytes are prefetched; original content was proven at enrollment and sealing. */
export type SemogObservedDocuments = {
  documentDataId: string;
  type: string;
  hashDataValue: string;
  hashSealed: string;
  sealed: Uint8Array;
};
export type SemogPreparedObserved = { ok: true; value: SemogObservedDocuments | null } | { ok: false; error: unknown };

/** Plain reads, no row locks; the same wait budget as the signing transaction. */
export const readSemogOutside = <T>(
  client: SemogPrismaTransactionRunner,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => client.$transaction(fn, { isolationLevel: 'ReadCommitted', timeout: 10000, maxWait: 10000 });

const readSealedSource = (client: SemogPrismaTransactionRunner, actor: SemogActor, key: string) =>
  readSemogOutside(client, async (tx) => {
    z.string().uuid().parse(key);
    const rows = await tx.$queryRaw<{ envelopeId: string; estado: string; execucao: unknown }[]>(
      Prisma.sql`SELECT "envelopeId", estado, execucao FROM semog_bridge.operations WHERE "chaveOperacao"=${key}::uuid AND "teamId"=${actor.teamId}`,
    );
    const operation = rows[0];
    const seal = ZSemogSealReceipt.safeParse(
      z.object({ selagem: z.unknown() }).safeParse(operation?.execucao).data?.selagem,
    );
    if (!operation || operation.estado !== 'concluida' || !seal.success) {
      return null;
    }
    const envelope = await tx.envelope.findFirst({
      where: { id: operation.envelopeId, teamId: actor.teamId, status: 'COMPLETED', completedAt: { not: null } },
      include: {
        envelopeItems: {
          include: { documentData: { select: { id: true, type: true, data: true } } },
        },
      },
    });
    const data = envelope?.envelopeItems.length === 1 ? envelope.envelopeItems[0].documentData : null;
    return data?.id === seal.data.documentDataId ? data : null;
  });

/** Every byte comes from storage outside any transaction; the transaction only compares digests. */
export const prepareSemogObserved = async (
  client: SemogPrismaTransactionRunner,
  readPdf: SemogPdfReader,
  actor: SemogActor,
  key: string,
  observe?: SemogStageObserver,
): Promise<SemogPreparedObserved> => {
  try {
    const data = await timeSemogStage(observe, 'pdf.source', () => readSealedSource(client, actor, key));
    if (data === null) {
      return { ok: true, value: null };
    }
    const sealed = await timeSemogStage(
      observe,
      'pdf.read',
      () => readPdf({ documentDataId: data.id, type: data.type, data: data.data }),
      (bytes) => ({ bytes: bytes.byteLength }),
    );
    return {
      ok: true,
      value: await timeSemogStage(observe, 'pdf.hash', () => ({
        documentDataId: data.id,
        type: data.type,
        hashDataValue: sha256(data.data),
        hashSealed: sha256(sealed),
        sealed,
      })),
    };
  } catch (error) {
    // Deferred like the signing read: surfaced only if the transaction reaches the point that needs the PDF.
    return { ok: false, error };
  }
};

/**
 * Only short digests leave PostgreSQL. New receipts need no binary decode at all. Old inline seals predate
 * persisted metadata: PostgreSQL hashes their decoded content for compatibility; object keys already carry it.
 */
export const readSemogDocumentDataDigest = async (
  tx: Prisma.TransactionClient,
  documentDataId: string,
  legacy = false,
) => {
  const rows = await tx.$queryRaw<
    {
      initial: string;
      data: string;
      type: string;
      originalContent: string | null;
      sealedContent: string | null;
      invalidEncoding: boolean;
      tooLarge: boolean;
    }[]
  >(Prisma.sql`WITH stored AS (
    SELECT *,
      (length("initialData") % 4 = 0 AND length(data) % 4 = 0
       AND "initialData" ~ '^[A-Za-z0-9+/]*([AQgw]==|[AEIMQUYcgkosw048]=)?$'
       AND data ~ '^[A-Za-z0-9+/]*([AQgw]==|[AEIMQUYcgkosw048]=)?$') canonical,
      (length("initialData") > ${4 * Math.ceil(SEMOG_MAX_SEALED_PDF_BYTES / 3)}
       OR length(data) > ${4 * Math.ceil(SEMOG_MAX_SEALED_PDF_BYTES / 3)}) oversized
    FROM public."DocumentData" WHERE id=${documentDataId}
  ) SELECT
    encode(sha256(convert_to("initialData",'UTF8')),'hex') initial,
    encode(sha256(convert_to(data,'UTF8')),'hex') data, type::text type,
    (${legacy} AND type='BYTES_64' AND NOT canonical) "invalidEncoding",
    (${legacy} AND type='BYTES_64' AND oversized) "tooLarge",
    CASE WHEN type='S3_PATH' THEN substring("initialData" from '^semog/pdf/([a-f0-9]{64})[.]pdf$')
      WHEN NOT ${legacy} THEN NULL
      WHEN type='BYTES_64' AND canonical AND NOT oversized THEN encode(sha256(decode("initialData",'base64')),'hex')
      WHEN type='BYTES' THEN encode(sha256(convert_to("initialData",'UTF8')),'hex') END "originalContent",
    CASE WHEN type='S3_PATH' THEN substring(data from '^semog/pdf/([a-f0-9]{64})[.]pdf$')
      WHEN NOT ${legacy} THEN NULL
      WHEN type='BYTES_64' AND canonical AND NOT oversized THEN encode(sha256(decode(data,'base64')),'hex')
      WHEN type='BYTES' THEN encode(sha256(convert_to(data,'UTF8')),'hex') END "sealedContent"
    FROM stored`);
  if (rows.length !== 1) {
    throw unavailable();
  }
  if (rows[0].tooLarge) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 400 });
  }
  if (rows[0].invalidEncoding) {
    // The old strict codec rejected malformed stored Base64 as an internal/unavailable read (HTTP 503).
    throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
  }
  return rows[0];
};

/** Receipt and current columns must still describe the immutable seal produced by the sealer. */
export const validateSemogSealMetadata = (
  receipt: z.infer<typeof ZSemogSealReceipt>,
  digest: Awaited<ReturnType<typeof readSemogDocumentDataDigest>>,
  hashDocumento: string,
) => {
  if (digest.data === digest.initial) {
    throw unavailable();
  }
  // The authorized storage migration preserves content hashes while changing type and column strings.
  if (digest.type === 'S3_PATH' || receipt.metadata === undefined) {
    if (digest.originalContent !== hashDocumento || digest.sealedContent !== receipt.hashPdf) {
      throw unavailable();
    }
    return;
  }
  const metadata = receipt.metadata;
  if (
    metadata.type !== digest.type ||
    metadata.hashInitialDataValue !== digest.initial ||
    metadata.hashDataValue !== digest.data ||
    metadata.hashOriginal !== hashDocumento
  ) {
    throw unavailable();
  }
};

/** Bind the single pre-read to the locked row and the persisted seal hash, never reading the original again. */
export const bindSemogObserved = (
  prepared: SemogPreparedObserved,
  expected: {
    documentDataId: string;
    digest: Awaited<ReturnType<typeof readSemogDocumentDataDigest>>;
    hashPdf: string;
    bytes?: number;
  },
) => {
  if (!prepared.ok) {
    throw prepared.error;
  }
  const observed = prepared.value;
  if (observed === null) {
    return null;
  }
  if (
    observed.documentDataId !== expected.documentDataId ||
    observed.type !== expected.digest.type ||
    observed.hashDataValue !== expected.digest.data ||
    observed.hashSealed !== expected.hashPdf ||
    (expected.bytes !== undefined && observed.sealed.byteLength !== expected.bytes)
  ) {
    throw unavailable();
  }
  return observed;
};
