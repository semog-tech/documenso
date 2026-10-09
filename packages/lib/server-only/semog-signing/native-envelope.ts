import type { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { ZSemogEnvelopeSnapshotSource } from './contract';
import type { SemogActor } from './service';

export const readSemogNativeEnvelope = async (tx: Prisma.TransactionClient, envelopeId: string, actor: SemogActor) => {
  const envelope = await tx.envelope.findFirst({
    where: { id: envelopeId, teamId: actor.teamId },
    include: {
      recipients: true,
      fields: true,
      documentMeta: true,
      envelopeAttachments: true,
      envelopeItems: { include: { documentData: true } },
    },
  });
  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, { statusCode: 404 });
  }
  // Prisma Date/Decimal serialization matches the server snapshot's declared ISO/string boundary.
  const serialized: unknown = JSON.parse(JSON.stringify(envelope));
  return { envelope, source: ZSemogEnvelopeSnapshotSource.parse(serialized) };
};
