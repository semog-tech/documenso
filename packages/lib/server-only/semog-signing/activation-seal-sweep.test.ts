import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRunIO } from '../../jobs/client/_internal/job';

type Builder = {
  selectFrom(...args: unknown[]): Builder;
  select(...args: unknown[]): Builder;
  where(...args: unknown[]): Builder;
  limit(...args: unknown[]): Builder;
  $if(condition: boolean, callback: (builder: Builder) => Builder): Builder;
  execute(): Promise<{ id: string; secondaryId: string }[]>;
};
const fixture = vi.hoisted(() => {
  const managed = vi.fn<() => Promise<string[]>>();
  const filter =
    vi.fn<
      (
        client: unknown,
        entries: { id: string; secondaryId: string }[],
        id: (entry: { id: string }) => string,
      ) => Promise<{ id: string; secondaryId: string }[]>
    >();
  const execute = vi.fn<() => Promise<{ id: string; secondaryId: string }[]>>();
  const where = vi.fn<(...args: unknown[]) => Builder>();
  const builder: Builder = {
    selectFrom: () => builder,
    select: () => builder,
    where,
    limit: () => builder,
    $if: (condition, callback) => (condition ? callback(builder) : builder),
    execute,
  };
  where.mockImplementation(() => builder);
  return { managed, filter, execute, where, builder, triggerJob: vi.fn() };
});
vi.mock('@documenso/prisma', () => ({
  prisma: {},
  kyselyPrisma: { $kysely: fixture.builder },
  sql: { lit: (value: unknown) => value },
}));
vi.mock('./activation-ownership', () => ({
  listSemogActivationManaged: fixture.managed,
  filterSemogUnmanaged: fixture.filter,
}));
vi.mock('../../jobs/client', () => ({ jobs: { triggerJob: fixture.triggerJob } }));

import { run } from '../../jobs/definitions/internal/seal-document-sweep.handler';

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
describe('native seal sweep ownership', () => {
  beforeEach(() => {
    fixture.managed.mockReset();
    fixture.execute.mockReset();
    fixture.filter.mockReset();
    fixture.where.mockClear();
    fixture.triggerJob.mockClear();
  });
  it('excludes managed IDs before the page limit and only queues native envelopes after the second gate', async () => {
    fixture.managed.mockResolvedValue(['semog']);
    fixture.execute.mockResolvedValue([
      { id: 'semog', secondaryId: 'document_1' },
      { id: 'native', secondaryId: 'document_2' },
    ]);
    fixture.filter.mockResolvedValue([{ id: 'native', secondaryId: 'document_2' }]);
    await run({ payload: {}, io });
    expect(fixture.where).toHaveBeenCalledWith('Envelope.id', 'not in', ['semog']);
    expect(fixture.triggerJob).toHaveBeenCalledTimes(1);
    expect(fixture.triggerJob).toHaveBeenCalledWith({
      name: 'internal.seal-document',
      payload: { documentId: 2, isResealing: true },
    });
  });
  it('never queues when either ownership gate fails', async () => {
    fixture.managed.mockRejectedValueOnce(new Error('ownership unavailable'));
    await expect(run({ payload: {}, io })).rejects.toThrow();
    expect(fixture.execute).not.toHaveBeenCalled();
    fixture.managed.mockResolvedValue([]);
    fixture.execute.mockResolvedValue([{ id: 'semog', secondaryId: 'document_1' }]);
    fixture.filter.mockRejectedValue(new Error('lookup unavailable'));
    await expect(run({ payload: {}, io })).rejects.toThrow();
    expect(fixture.triggerJob).not.toHaveBeenCalled();
  });
});
