import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const SEMOG_STORAGE_PURGE_SWEEP_JOB_DEFINITION_ID = 'internal.semog-storage-purge-sweep';

const SEMOG_STORAGE_PURGE_SWEEP_JOB_DEFINITION_SCHEMA = z.object({});

export type TSemogStoragePurgeSweepJobDefinition = z.infer<typeof SEMOG_STORAGE_PURGE_SWEEP_JOB_DEFINITION_SCHEMA>;

export const SEMOG_STORAGE_PURGE_SWEEP_JOB_DEFINITION = {
  id: SEMOG_STORAGE_PURGE_SWEEP_JOB_DEFINITION_ID,
  name: 'Semog Storage Purge Sweep',
  version: '1.0.0',
  trigger: {
    name: SEMOG_STORAGE_PURGE_SWEEP_JOB_DEFINITION_ID,
    schema: SEMOG_STORAGE_PURGE_SWEEP_JOB_DEFINITION_SCHEMA,
    cron: '0 6 * * *', // Daily at 06:00 UTC (03:00 in Brasília).
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./semog-storage-purge-sweep.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof SEMOG_STORAGE_PURGE_SWEEP_JOB_DEFINITION_ID,
  TSemogStoragePurgeSweepJobDefinition
>;
