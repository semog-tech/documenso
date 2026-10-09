import { prisma } from '@documenso/prisma';
import { DocumentStatus, SigningStatus } from '@prisma/client';
import {
  filterSemogUnmanaged,
  listSemogActivationManaged,
} from '../../../server-only/semog-signing/activation-ownership';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TExpireRecipientsSweepJobDefinition } from './expire-recipients-sweep';

export const run = async ({ io }: { payload: TExpireRecipientsSweepJobDefinition; io: JobRunIO }) => {
  const now = new Date();
  const managedEnvelopeIds = await listSemogActivationManaged(prisma);

  const expiredRecipients = await prisma.recipient.findMany({
    where: {
      expiresAt: {
        lte: now,
      },
      expirationNotifiedAt: null,
      signingStatus: {
        notIn: [SigningStatus.SIGNED, SigningStatus.REJECTED],
      },
      envelope: {
        status: DocumentStatus.PENDING,
        id: { notIn: managedEnvelopeIds },
      },
    },
    select: {
      id: true,
      envelopeId: true,
    },
    take: 1000, // Limit to 1000 to avoid long-running jobs. Will be picked up in the next run if there are more.
  });

  if (expiredRecipients.length === 0) {
    io.logger.info('No expired recipients found');
    return;
  }

  io.logger.info(`Found ${expiredRecipients.length} expired recipients`);

  // Resolve the whole batch before enqueueing: an uncertain ownership lookup must not send anything.
  const nativeRecipients = await filterSemogUnmanaged(prisma, expiredRecipients, (recipient) => recipient.envelopeId);
  await Promise.allSettled(
    nativeRecipients.map(async (recipient) => {
      await jobs.triggerJob({
        name: 'internal.process-recipient-expired',
        payload: {
          recipientId: recipient.id,
        },
      });
    }),
  );
};
