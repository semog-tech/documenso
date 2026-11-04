import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SemogPdfDiskCache } from './pdf-disk-cache';
import { createSemogPdfDiskCache } from './pdf-disk-cache';

const keyFor = (bytes: Uint8Array) => `semog/pdf/${createHash('sha256').update(bytes).digest('hex')}.pdf`;
const bytesA = Uint8Array.from([1, 2, 3]);
const bytesB = Uint8Array.from([4, 5, 6]);
const bytesC = Uint8Array.from([7, 8, 9]);

describe('disposable PDF disk cache', () => {
  let directory: string;
  const caches: SemogPdfDiskCache[] = [];
  const makeCache = (options: Partial<Parameters<typeof createSemogPdfDiskCache>[0]> = {}) => {
    const cache = createSemogPdfDiskCache({ enabled: true, directory, minFreeBytes: 0, ...options });
    caches.push(cache);
    return cache;
  };
  const files = async () => (await fs.readdir(directory)).filter((name) => name.endsWith('.pdf'));
  beforeEach(async () => {
    const root = await fs.realpath(tmpdir());
    directory = await fs.mkdtemp(join(root, 'semog-pdf-cache-test-'));
  });
  afterEach(async () => {
    for (const cache of caches.splice(0)) {
      cache.close();
    }
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('populates after R2 read, hashes every hit, and returns private buffers', async () => {
    const cache = makeCache();
    const load = vi.fn(async () => bytesA);
    expect(await cache.read(keyFor(bytesA), load)).toEqual(bytesA);
    const hit = await cache.read(keyFor(bytesA), load);
    hit[0] = 99;
    expect(await cache.read(keyFor(bytesA), load)).toEqual(bytesA);
    expect(load).toHaveBeenCalledTimes(1);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(directory, (await files())[0]))).mode & 0o777).toBe(0o600);
  });

  it('removes corrupt bytes and reloads from R2', async () => {
    const onWarning = vi.fn();
    const cache = makeCache({ onWarning });
    await cache.write(keyFor(bytesA), bytesA);
    await fs.writeFile(join(directory, (await files())[0]), bytesB);
    const load = vi.fn(async () => bytesA);
    expect(await cache.read(keyFor(bytesA), load)).toEqual(bytesA);
    expect(load).toHaveBeenCalledOnce();
    expect(onWarning).toHaveBeenCalledWith('corrupt');
    expect(await fs.readFile(join(directory, (await files())[0]))).toEqual(Buffer.from(bytesA));
  });

  it('evicts least recently used before writing and bypasses oversized objects', async () => {
    const cache = makeCache({ maxBytes: 6 });
    await cache.write(keyFor(bytesA), bytesA);
    const first = join(directory, (await files())[0]);
    const old = new Date(Date.now() - 10000);
    await fs.utimes(first, old, old);
    await cache.write(keyFor(bytesB), bytesB);
    for (const name of await files()) {
      await fs.utimes(join(directory, name), old, old);
    }
    await cache.read(keyFor(bytesA), () => Promise.reject(new Error('must be a hit')));
    await cache.write(keyFor(bytesC), bytesC);
    const load = vi.fn(async () => bytesB);
    await cache.read(keyFor(bytesB), load);
    expect(load).toHaveBeenCalledOnce();
    expect((await files()).length).toBe(2);
    const huge = new Uint8Array(7);
    await cache.write(keyFor(huge), huge);
    expect((await files()).length).toBe(2);
  });

  it('does not touch disk or coalesce when disabled', async () => {
    const cache = makeCache({ enabled: false, directory: join(directory, 'disabled') });
    const load = vi.fn(async () => bytesA);
    await cache.write(keyFor(bytesA), bytesA);
    await Promise.all([cache.read(keyFor(bytesA), load), cache.read(keyFor(bytesA), load)]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('counts both old files and the atomic temporary against the ceiling', async () => {
    const cache = makeCache({ maxBytes: 6 });
    await cache.write(keyFor(bytesA), bytesA);
    await cache.write(keyFor(bytesB), bytesB);
    const rename = fs.rename;
    const observedSizes: number[] = [];
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const stats = await Promise.all((await fs.readdir(directory)).map((name) => fs.stat(join(directory, name))));
      observedSizes.push(stats.reduce((sum, stat) => sum + stat.size, 0));
      await rename(from, to);
    });
    await cache.write(keyFor(bytesA), bytesA);
    expect(observedSizes).toEqual([6]);
  });

  it('coalesces concurrent misses into one R2 call without sharing mutable bytes', async () => {
    const cache = makeCache();
    const load = vi.fn(async () => bytesA);
    const [one, two] = await Promise.all([cache.read(keyFor(bytesA), load), cache.read(keyFor(bytesA), load)]);
    expect(load).toHaveBeenCalledOnce();
    one[0] = 99;
    expect(two).toEqual(bytesA);
  });

  it('propagates original R2 failure and allows a retry', async () => {
    const cache = makeCache();
    const failure = new Error('R2 unavailable');
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(bytesA);
    await expect(cache.read(keyFor(bytesA), load)).rejects.toBe(failure);
    expect(await cache.read(keyFor(bytesA), load)).toEqual(bytesA);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('removes partial temporary writes and falls back to R2 without exposing partial PDF', async () => {
    const cache = makeCache();
    // Initialization is complete before injecting the interrupted write.
    await cache.invalidate(keyFor(bytesA));
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
          await handle.write(Uint8Array.from([1]));
          throw new Error('disk full during write');
        });
      }
      return handle;
    });
    const load = vi.fn(async () => bytesA);
    expect(await cache.read(keyFor(bytesA), load)).toEqual(bytesA);
    expect(await fs.readdir(directory)).toEqual([]);
    vi.restoreAllMocks();
    await cache.read(keyFor(bytesA), load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('cleans orphan temporaries and expired entries on startup', async () => {
    const cache = makeCache();
    await cache.write(keyFor(bytesA), bytesA);
    cache.close();
    const old = new Date(Date.now() - 10000);
    await fs.utimes(join(directory, (await files())[0]), old, old);
    await fs.writeFile(join(directory, '.semog-abcd-1234.tmp'), 'partial');
    const restarted = makeCache({ idleTtlMs: 1000 });
    await restarted.invalidate(keyFor(bytesB));
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('expires idle entries with the periodic sweep', async () => {
    const cache = makeCache({ idleTtlMs: 1000, sweepIntervalMs: 10 });
    await cache.write(keyFor(bytesA), bytesA);
    const old = new Date(Date.now() - 10000);
    await fs.utimes(join(directory, (await files())[0]), old, old);
    await vi.waitFor(async () => expect(await files()).toEqual([]));
  });

  it('uses 72 hours as the default idle lifetime, including after restart', async () => {
    const cache = makeCache();
    await cache.write(keyFor(bytesA), bytesA);
    const path = join(directory, (await files())[0]);
    const old = new Date(Date.now() - 73 * 60 * 60 * 1000);
    await fs.utimes(path, old, old);
    cache.close();
    const restarted = makeCache();
    const load = vi.fn(async () => bytesA);
    expect(await restarted.read(keyFor(bytesA), load)).toEqual(bytesA);
    expect(load).toHaveBeenCalledOnce();
  });

  it('falls back when the directory is unavailable without failing the operation', async () => {
    const onWarning = vi.fn();
    const unavailable = join(directory, 'regular-file');
    await fs.writeFile(unavailable, 'not a directory');
    const cache = makeCache({ directory: unavailable, onWarning });
    const load = vi.fn(async () => bytesA);
    expect(await cache.read(keyFor(bytesA), load)).toEqual(bytesA);
    expect(onWarning).toHaveBeenCalledWith('unavailable');
    expect(await fs.readFile(unavailable, 'utf8')).toBe('not a directory');
  });

  it('stops writes under the minimum free disk reserve, with a safe warning', async () => {
    const onWarning = vi.fn();
    const cache = makeCache({ minFreeBytes: Number.MAX_SAFE_INTEGER, onWarning });
    const load = vi.fn(async () => bytesA);
    expect(await cache.read(keyFor(bytesA), load)).toEqual(bytesA);
    expect(await files()).toEqual([]);
    expect(onWarning).toHaveBeenCalledWith('low-space');
  });

  it('preserves cached hits when even planned LRU eviction cannot provide the disk reserve', async () => {
    const onWarning = vi.fn();
    const cache = makeCache({ maxBytes: 6, minFreeBytes: 2, onWarning });
    await cache.write(keyFor(bytesA), bytesA);
    await cache.write(keyFor(bytesB), bytesB);
    const before = await files();
    const space = await fs.statfs(directory);
    vi.spyOn(fs, 'statfs').mockResolvedValue({ ...space, bsize: 1, bavail: 0 });
    // Evicting one 3-byte entry meets the cache ceiling, but leaves no 2-byte disk reserve.
    await cache.write(keyFor(bytesC), bytesC);
    expect(await files()).toEqual(before);
    expect(onWarning).toHaveBeenCalledWith('low-space');
    const load = vi.fn(() => Promise.reject(new Error('cached hits must remain available')));
    expect(await cache.read(keyFor(bytesA), load)).toEqual(bytesA);
    expect(await cache.read(keyFor(bytesB), load)).toEqual(bytesB);
    expect(load).not.toHaveBeenCalled();
  });

  it('allows a write when planned LRU eviction recovers the required disk reserve', async () => {
    const onWarning = vi.fn();
    const cache = makeCache({ maxBytes: 6, minFreeBytes: 2, onWarning });
    await cache.write(keyFor(bytesA), bytesA);
    const oldest = join(directory, (await files())[0]);
    const old = new Date(Date.now() - 10000);
    await fs.utimes(oldest, old, old);
    await cache.write(keyFor(bytesB), bytesB);
    const space = await fs.statfs(directory);
    const statfs = vi
      .spyOn(fs, 'statfs')
      .mockResolvedValueOnce({ ...space, bsize: 1, bavail: 2 })
      .mockResolvedValue({ ...space, bsize: 1, bavail: 5 });
    await cache.write(keyFor(bytesC), bytesC);
    expect(statfs).toHaveBeenCalledTimes(2);
    await expect(fs.stat(oldest)).rejects.toMatchObject({ code: 'ENOENT' });
    const load = vi.fn(() => Promise.reject(new Error('expected cache hit')));
    expect(await cache.read(keyFor(bytesB), load)).toEqual(bytesB);
    expect(await cache.read(keyFor(bytesC), load)).toEqual(bytesC);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it.each([
    2_147_483_648,
    Number.MAX_SAFE_INTEGER,
    Number.NaN,
    0,
  ])('disables direct invalid sweep options without creating a Node timer: %s', async (sweepIntervalMs) => {
    const onWarning = vi.fn();
    const interval = vi.spyOn(globalThis, 'setInterval');
    const cache = makeCache({ directory: join(directory, 'disabled'), sweepIntervalMs, onWarning });
    const load = vi.fn(async () => bytesA);
    await cache.write(keyFor(bytesA), bytesA);
    await Promise.all([cache.read(keyFor(bytesA), load), cache.read(keyFor(bytesA), load)]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(interval).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledExactlyOnceWith('unavailable');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('accepts the maximum direct Node timer interval', async () => {
    const onWarning = vi.fn();
    const interval = vi.spyOn(globalThis, 'setInterval');
    const cache = makeCache({ sweepIntervalMs: 2_147_483_647, onWarning });
    await cache.write(keyFor(bytesA), bytesA);
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647);
    expect(onWarning).not.toHaveBeenCalled();
    expect((await files()).length).toBe(1);
  });

  it('isolates identical content across object scopes and rejects path traversal keys', async () => {
    const one = makeCache({ scope: 'bucket-one' });
    const two = makeCache({ scope: 'bucket-two' });
    await one.write(keyFor(bytesA), bytesA);
    const load = vi.fn(async () => bytesA);
    await two.read(keyFor(bytesA), load);
    expect(load).toHaveBeenCalledOnce();
    expect((await files()).length).toBe(2);
    await one.write('../../outside.pdf', bytesA);
    expect(await one.read('../../outside.pdf', load)).toEqual(bytesA);
    expect((await files()).length).toBe(2);
  });

  it('rejects a symlink cache entry and never changes the external file', async () => {
    const cache = makeCache();
    await cache.write(keyFor(bytesA), bytesA);
    const path = join(directory, (await files())[0]);
    const outside = join(directory, 'external-test-file');
    await fs.writeFile(outside, bytesB);
    await fs.unlink(path);
    await fs.symlink(outside, path);
    expect(await cache.read(keyFor(bytesA), async () => bytesA)).toEqual(bytesA);
    expect(await fs.readFile(outside)).toEqual(Buffer.from(bytesB));
  });

  it('invalidates while a miss is in flight without leaving a new copy behind', async () => {
    const cache = makeCache();
    let finish: (value: Uint8Array) => void = () => {
      throw new Error('not started');
    };
    let started: () => void = () => {
      throw new Error('not started');
    };
    const loading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const reading = cache.read(keyFor(bytesA), () => {
      started();
      return new Promise<Uint8Array>((resolve) => {
        finish = resolve;
      });
    });
    await loading;
    const invalidating = cache.invalidate(keyFor(bytesA));
    finish(bytesA);
    expect(await reading).toEqual(bytesA);
    await invalidating;
    expect(await files()).toEqual([]);
  });

  it('never stores bytes that do not match the content key', async () => {
    const onWarning = vi.fn(() => {
      throw new Error('observer broken');
    });
    const cache = makeCache({ onWarning });
    await cache.write(keyFor(bytesA), bytesB);
    expect(await files()).toEqual([]);
    expect(onWarning).toHaveBeenCalledWith('invalid-content');
  });
});
