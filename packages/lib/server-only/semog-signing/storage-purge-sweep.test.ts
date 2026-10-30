import { describe, expect, it, vi } from 'vitest';
import type { SemogPurgeSweepDeps } from './storage-purge-sweep';
import { sweepSemogCancelledStorage } from './storage-purge-sweep';

const deps = (env: Record<string, string>, migrated: boolean) => {
  const info = vi.fn();
  const queryRaw = vi.fn(() => Promise.resolve([{ ready: migrated }]));
  const createObjects = vi.fn();
  const value: SemogPurgeSweepDeps = {
    // Only the readiness probe is reached in these cases; anything else would fail the test through createObjects.
    client: { $queryRaw: queryRaw } as unknown as SemogPurgeSweepDeps['client'],
    read: (name) => env[name],
    createObjects,
    log: { info, error: vi.fn() },
  };
  return { value, info, createObjects };
};
const ON = { SEMOG_SIGNING_ENABLED: 'true', NEXT_PUBLIC_UPLOAD_TRANSPORT: 's3', NEXT_PRIVATE_UPLOAD_BUCKET: 'b' };

describe('Varredura diária da purga', () => {
  it.each([
    [{ ...ON, SEMOG_SIGNING_ENABLED: 'false' }, true, /ponte desligada/],
    [{ ...ON, SEMOG_STORAGE_PURGE_ENABLED: 'false' }, true, /purga desligada/],
    [ON, false, /migração .* ausente/],
    [{ ...ON, NEXT_PUBLIC_UPLOAD_TRANSPORT: 'database' }, true, /não é s3/],
  ])('não faz nada e diz por quê (%#)', async (env, migrated, reason) => {
    const { value, info, createObjects } = deps(env, migrated);
    expect(await sweepSemogCancelledStorage(value)).toEqual([]);
    expect(createObjects).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(reason));
  });
});
