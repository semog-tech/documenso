import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRunIO } from '../../jobs/client/_internal/job';

const doubles = vi.hoisted(() => ({
  managed: vi.fn<(client: unknown, id: string) => Promise<boolean>>(),
  listManaged: vi.fn<() => Promise<string[]>>(),
  findMany: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  findUnique: vi.fn(),
  findEnvelope: vi.fn(),
  updateMany: vi.fn(),
  triggerJob: vi.fn(),
  triggerWebhook: vi.fn(),
}));
vi.mock('@documenso/prisma', () => ({
  prisma: {
    recipient: {
      findMany: doubles.findMany,
      findUniqueOrThrow: doubles.findUniqueOrThrow,
      findUnique: doubles.findUnique,
      updateMany: doubles.updateMany,
    },
    envelope: { findFirstOrThrow: doubles.findEnvelope },
  },
}));
vi.mock('./activation-ownership', () => ({
  isSemogActivationManaged: doubles.managed,
  listSemogActivationManaged: doubles.listManaged,
  filterSemogUnmanaged: async <T>(client: unknown, entries: T[], envelopeId: (entry: T) => string) => {
    const flags = await Promise.all(entries.map((entry) => doubles.managed(client, envelopeId(entry))));
    return entries.filter((_, index) => !flags[index]);
  },
}));
vi.mock('@documenso/ee/server-only/signing/csc/finalize-tsp-completion', () => ({
  finalizeTspEnvelopeCompletion: vi.fn(),
}));
vi.mock('@documenso/signing', () => ({ signPdf: vi.fn() }));
vi.mock('../../client-only/providers/i18n-server', () => ({ getI18nInstance: vi.fn() }));
vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({ getI18nInstance: vi.fn() }));
vi.mock('../../jobs/client', () => ({ jobs: { triggerJob: doubles.triggerJob } }));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: doubles.triggerWebhook }));

import { run as sweep } from '../../jobs/definitions/internal/expire-recipients-sweep.handler';
import { run as processExpired } from '../../jobs/definitions/internal/process-recipient-expired.handler';
import { run as processReminder } from '../../jobs/definitions/internal/process-signing-reminder.handler';
import { run as seal } from '../../jobs/definitions/internal/seal-document.handler';
import { run as remindSweep } from '../../jobs/definitions/internal/send-signing-reminders-sweep.handler';

const io: JobRunIO = {
  runTask: (_key, callback) => callback(),
  triggerJob: async () => undefined,
  wait: async () => undefined,
  logger: {
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    log: () => undefined,
  },
};
describe('native expiration workers suppress Semog effects', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.listManaged.mockResolvedValue(['semog']);
  });
  it('sweep only queues native recipients after all ownership lookups succeed', async () => {
    doubles.findMany.mockResolvedValue([
      { id: 1, envelopeId: 'semog' },
      { id: 2, envelopeId: 'native' },
    ]);
    doubles.managed.mockImplementation(async (_client, id) => id === 'semog');
    await sweep({ payload: {}, io });
    expect(doubles.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ envelope: { status: 'PENDING', id: { notIn: ['semog'] } } }),
      }),
    );
    expect(doubles.triggerJob).toHaveBeenCalledTimes(1);
    expect(doubles.triggerJob).toHaveBeenCalledWith({
      name: 'internal.process-recipient-expired',
      payload: { recipientId: 2 },
    });
  });
  it('sweep fails closed for an indeterminate receipt lookup', async () => {
    doubles.findMany.mockResolvedValue([
      { id: 1, envelopeId: 'semog' },
      { id: 2, envelopeId: 'native' },
    ]);
    doubles.managed.mockRejectedValue(new Error('database unavailable'));
    await expect(sweep({ payload: {}, io })).rejects.toThrow();
    expect(doubles.triggerJob).not.toHaveBeenCalled();
  });
  it('processor checks ownership before claiming expiry or triggering effects', async () => {
    doubles.findUniqueOrThrow.mockResolvedValue({ envelopeId: 'semog' });
    doubles.managed.mockResolvedValue(true);
    await processExpired({ payload: { recipientId: 1 }, io });
    expect(doubles.updateMany).not.toHaveBeenCalled();
    expect(doubles.triggerJob).not.toHaveBeenCalled();
    expect(doubles.triggerWebhook).not.toHaveBeenCalled();
    doubles.managed.mockRejectedValue(new Error('receipt lookup failed'));
    await expect(processExpired({ payload: { recipientId: 1 }, io })).rejects.toThrow();
    expect(doubles.updateMany).not.toHaveBeenCalled();
    expect(doubles.triggerJob).not.toHaveBeenCalled();
    expect(doubles.triggerWebhook).not.toHaveBeenCalled();
  });
  it('reminder sweep filters managed recipients before queueing', async () => {
    doubles.findMany.mockResolvedValue([
      { id: 1, envelopeId: 'semog' },
      { id: 2, envelopeId: 'native' },
    ]);
    doubles.managed.mockImplementation(async (_client, id) => id === 'semog');
    await remindSweep({ payload: {}, io });
    expect(doubles.triggerJob).toHaveBeenCalledTimes(1);
    expect(doubles.triggerJob).toHaveBeenCalledWith({
      name: 'internal.process-signing-reminder',
      payload: { recipientId: 2 },
    });
  });
  it('reminder processor and native sealer stop before all mutations/effects; failures propagate', async () => {
    doubles.findUnique.mockResolvedValue({ envelopeId: 'semog' });
    doubles.findEnvelope.mockResolvedValue({ id: 'semog' });
    doubles.managed.mockResolvedValue(true);
    await processReminder({ payload: { recipientId: 1 }, io });
    await seal({ payload: { documentId: 1 }, io });
    expect(doubles.updateMany).not.toHaveBeenCalled();
    expect(doubles.triggerJob).not.toHaveBeenCalled();
    expect(doubles.triggerWebhook).not.toHaveBeenCalled();
    doubles.managed.mockRejectedValue(new Error('lookup unavailable'));
    await expect(processReminder({ payload: { recipientId: 1 }, io })).rejects.toThrow();
    await expect(seal({ payload: { documentId: 1 }, io })).rejects.toThrow();
    expect(doubles.updateMany).not.toHaveBeenCalled();
    expect(doubles.triggerJob).not.toHaveBeenCalled();
    expect(doubles.triggerWebhook).not.toHaveBeenCalled();
  });
});
