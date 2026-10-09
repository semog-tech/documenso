import { prisma } from '@documenso/prisma';
import { DocumentStatus, RecipientRole, SendStatus, SigningStatus } from '@prisma/client';
import {
  filterSemogUnmanaged,
  listSemogActivationManaged,
} from '../../../server-only/semog-signing/activation-ownership';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSendSigningRemindersSweepJobDefinition } from './send-signing-reminders-sweep';

export const run = async ({ io }: { payload: TSendSigningRemindersSweepJobDefinition; io: JobRunIO }) => {
  const now = new Date();
  const managedEnvelopeIds = await listSemogActivationManaged(prisma);

  const recipients = await prisma.recipient.findMany({
    where: {
      nextReminderAt: { lte: now },
      signingStatus: SigningStatus.NOT_SIGNED,
      sendStatus: SendStatus.SENT,
      role: { not: RecipientRole.CC },
      // Skip recipients whose signing deadline has passed. `expiresAt`
      // is the source of truth — the expiration sweep asynchronously
      // sets `expirationNotifiedAt`, so filtering on `expiresAt` also
      // covers the window before the expiration sweep runs.
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      envelope: {
        id: { notIn: managedEnvelopeIds },
        status: DocumentStatus.PENDING,
        deletedAt: null,
      },
    },
    select: { id: true, envelopeId: true },
    take: 1000,
  });

  if (recipients.length === 0) {
    io.logger.info('No recipients need signing reminders');
    return;
  }

  io.logger.info(`Found ${recipients.length} recipients needing signing reminders`);

  const nativeRecipients = await filterSemogUnmanaged(prisma, recipients, (recipient) => recipient.envelopeId);
  await Promise.allSettled(
    nativeRecipients.map(async (recipient) => {
      await jobs.triggerJob({
        name: 'internal.process-signing-reminder',
        payload: {
          recipientId: recipient.id,
        },
      });
    }),
  );
};
