import { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { ZSemogEnvelopeSnapshotSource, ZSemogEnvelopeStructureSource } from './contract';
import type { SemogActor } from './service';

const findEnvelope = <T extends Prisma.DocumentDataSelect>(
  tx: Prisma.TransactionClient,
  envelopeId: string,
  actor: SemogActor,
  documentData: T,
) =>
  tx.envelope.findFirst({
    where: { id: envelopeId, teamId: actor.teamId },
    include: {
      recipients: true,
      fields: true,
      documentMeta: true,
      envelopeAttachments: true,
      envelopeItems: { include: { documentData: { select: documentData } } },
    },
  });

// `data` is never read here: before sealing it repeats INITIAL_DATA, and inline it doubles the PDF read from the database.
export const readSemogNativeEnvelope = async (tx: Prisma.TransactionClient, envelopeId: string, actor: SemogActor) => {
  const envelope = await findEnvelope(tx, envelopeId, actor, { id: true, type: true, initialData: true });
  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, { statusCode: 404 });
  }
  // Prisma Date/Decimal serialization matches the server snapshot's declared ISO/string boundary.
  const serialized: unknown = JSON.parse(JSON.stringify(envelope));
  return { envelope, source: ZSemogEnvelopeSnapshotSource.parse(serialized) };
};

/** Same envelope for the signing transaction: INITIAL_DATA stays in the database, only its SHA-256 comes back. */
export const readSemogNativeEnvelopeStructure = async (
  tx: Prisma.TransactionClient,
  envelopeId: string,
  actor: SemogActor,
) => {
  const envelope = await findEnvelope(tx, envelopeId, actor, { id: true, type: true });
  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, { statusCode: 404 });
  }
  const serialized: unknown = JSON.parse(JSON.stringify(envelope));
  const source = ZSemogEnvelopeStructureSource.parse(serialized);
  // Same UTF-8 bytes Node's createHash(string) hashes in hashSemogDocument.
  const rows = await tx.$queryRaw<{ hash: string }[]>(
    Prisma.sql`SELECT encode(sha256(convert_to("initialData",'UTF8')),'hex') hash FROM public."DocumentData" WHERE id=${source.envelopeItems[0].documentData.id}`,
  );
  if (rows.length !== 1) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
  }
  return { envelope, source, hashInitialData: rows[0].hash };
};
