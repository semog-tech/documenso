import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { filterSemogUnmanaged, isSemogActivationManaged, listSemogActivationManaged } from './activation-ownership';

describe('expiration ownership gate', () => {
  const lookup = () => {
    const query = vi.fn<(query: Prisma.Sql) => Promise<unknown>>();
    // This adapter supplies the raw SQL result only; production Prisma implements the generic query overload.
    const client = { $queryRaw: query } as unknown as Parameters<typeof isSemogActivationManaged>[0];
    return { query, client };
  };
  it('excludes receipts and preserves unmanaged or never-enabled native hosts', async () => {
    for (const managed of [true, false]) {
      const { query, client } = lookup();
      query.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([{ managed }]);
      expect(await isSemogActivationManaged(client, 'envelope-local')).toBe(managed);
      expect(query.mock.calls[1][0].values).toContain('envelope-local');
    }
    const { query, client } = lookup();
    query.mockResolvedValueOnce([{ present: false }]);
    expect(await isSemogActivationManaged(client, 'native-old')).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('propagates errors and malformed results instead of authorizing native dispatch', async () => {
    const { query, client } = lookup();
    query.mockRejectedValueOnce(new Error('permission denied'));
    await expect(isSemogActivationManaged(client, 'local')).rejects.toThrow('permission denied');
    query.mockResolvedValueOnce([]);
    await expect(isSemogActivationManaged(client, 'local')).rejects.toThrow('unavailable');
    query.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([{ managed: 'false' }]);
    await expect(isSemogActivationManaged(client, 'local')).rejects.toThrow('unavailable');
  });
  it('lists active managed IDs before paging and propagates batch failures', async () => {
    const { query, client } = lookup();
    query.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([{ envelopeId: 'semog' }]);
    expect(await listSemogActivationManaged(client)).toEqual(['semog']);
    query.mockRejectedValue(new Error('lookup failed'));
    await expect(
      filterSemogUnmanaged(client, [{ id: 'semog' }, { id: 'stock' }], (entry) => entry.id),
    ).rejects.toThrow();
  });
});
