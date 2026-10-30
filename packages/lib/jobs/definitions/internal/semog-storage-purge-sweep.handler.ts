import { prisma } from '@documenso/prisma';
import { createSemogS3PurgeObjects } from '../../../server-only/semog-signing/pdf-store-s3';
import { sweepSemogCancelledStorage } from '../../../server-only/semog-signing/storage-purge-sweep';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSemogStoragePurgeSweepJobDefinition } from './semog-storage-purge-sweep';

export const run = async ({ io }: { payload: TSemogStoragePurgeSweepJobDefinition; io: JobRunIO }) => {
  await sweepSemogCancelledStorage({
    client: prisma,
    read: (name) => process.env[name],
    createObjects: createSemogS3PurgeObjects,
    log: { info: (message) => io.logger.info(message), error: (message) => io.logger.error(message) },
  });
};
