import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { SemogPrismaTransactionRunner } from './execution';
import type { SemogPdfReader } from './initial-pdf';
import { SEMOG_MAX_SEALED_PDF_BYTES, validateSemogPdf } from './initial-pdf';
import type { SemogActor } from './service';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
export const ZSemogSealReceipt = z.object({ documentDataId: z.string(), hashPdf: z.string().regex(/^[a-f0-9]{64}$/) });

/** A concluded signature's original and sealed PDFs, read and checked before the Serializable transaction. */
export type SemogObservedDocuments = {
  documentDataId: string;
  /** SHA-256 of the column strings as read; the transaction compares the database's own digest of them. */
  hashInitialDataValue: string;
  hashDataValue: string;
  hashOriginal: string;
  hashSealed: string;
  /** Parse/signature-marker failure of the sealed file, rethrown where the in-transaction check used to fail. */
  sealedError: unknown;
  sealed: Uint8Array;
};
/** `null`: nothing sealed yet when read — the transaction then reports the PDF as not yet available. */
export type SemogPreparedObserved = { ok: true; value: SemogObservedDocuments | null } | { ok: false; error: unknown };

/** Plain reads, no row locks; the same wait budget as the signing transaction. */
export const readSemogOutside = <T>(
  client: SemogPrismaTransactionRunner,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => client.$transaction(fn, { isolationLevel: 'ReadCommitted', timeout: 10000, maxWait: 10000 });

const inspectSealed = async (pdf: Uint8Array) => {
  try {
    await validateSemogPdf(pdf, [], SEMOG_MAX_SEALED_PDF_BYTES);
  } catch (error) {
    return error;
  }
  const contents = Buffer.from(pdf).toString('latin1');
  return contents.includes('/ByteRange') && contents.includes('/ETSI.CAdES.detached') ? null : unavailable();
};
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
          include: { documentData: { select: { id: true, type: true, data: true, initialData: true } } },
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
): Promise<SemogPreparedObserved> => {
  try {
    const data = await readSealedSource(client, actor, key);
    if (data === null) {
      return { ok: true, value: null };
    }
    const original = await readPdf({ documentDataId: data.id, type: data.type, data: data.initialData });
    const sealed = await readPdf({ documentDataId: data.id, type: data.type, data: data.data });
    return {
      ok: true,
      value: {
        documentDataId: data.id,
        hashInitialDataValue: sha256(data.initialData),
        hashDataValue: sha256(data.data),
        hashOriginal: sha256(original),
        hashSealed: sha256(sealed),
        sealedError: await inspectSealed(sealed),
        sealed,
      },
    };
  } catch (error) {
    // Deferred like the signing read: surfaced only if the transaction reaches the point that needs the PDF.
    return { ok: false, error };
  }
};

/** Database digests of both columns: proves under the lock what the pre-read hashed, without moving the bytes. */
export const readSemogDocumentDataDigest = async (tx: Prisma.TransactionClient, documentDataId: string) => {
  const rows = await tx.$queryRaw<{ initial: string; data: string }[]>(
    Prisma.sql`SELECT encode(sha256(convert_to("initialData",'UTF8')),'hex') initial, encode(sha256(convert_to(data,'UTF8')),'hex') data FROM public."DocumentData" WHERE id=${documentDataId}`,
  );
  if (rows.length !== 1) {
    throw unavailable();
  }
  return rows[0];
};

/**
 * Inside the transaction: the receipt's DocumentData still holds exactly the strings whose bytes were read, the
 * original hashes to the signed SHA-256 and the sealed file to the receipt. Returns null when nothing was read yet.
 */
export const bindSemogObserved = (
  prepared: SemogPreparedObserved,
  expected: {
    documentDataId: string;
    digest: { initial: string; data: string };
    hashDocumento: string;
    hashPdf: string;
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
    observed.hashInitialDataValue !== expected.digest.initial ||
    observed.hashDataValue !== expected.digest.data ||
    observed.hashOriginal !== expected.hashDocumento
  ) {
    throw unavailable();
  }
  if (observed.hashSealed !== expected.hashPdf) {
    throw unavailable();
  }
  if (observed.sealedError !== null) {
    throw observed.sealedError;
  }
  return observed;
};
