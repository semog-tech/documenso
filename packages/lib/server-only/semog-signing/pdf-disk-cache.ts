import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { semogPdfKeyHash } from './pdf-store';

export type SemogPdfDiskCacheWarning = 'unavailable' | 'corrupt' | 'low-space' | 'invalid-content';
export type SemogPdfDiskCacheOptions = {
  enabled: boolean;
  directory: string;
  /** Separate buckets/endpoints that use the same volume. Never put an object key into a path. */
  scope?: string;
  maxBytes?: number;
  idleTtlMs?: number;
  minFreeBytes?: number;
  sweepIntervalMs?: number;
  onWarning?: (reason: SemogPdfDiskCacheWarning) => void;
};
export type SemogPdfDiskCache = {
  read: (key: string, load: () => Promise<Uint8Array>) => Promise<Uint8Array>;
  write: (key: string, bytes: Uint8Array) => Promise<void>;
  invalidate: (key: string) => Promise<void>;
  close: () => void;
};

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const ENTRY = /^[a-f0-9]{64}-[a-f0-9]{64}\.pdf$/;
const TEMP = /^\.semog-[a-f0-9-]+\.tmp$/;
export const SEMOG_PDF_CACHE_MAX_SWEEP_MS = 2_147_483_647;
const isMissing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
type Entry = { path: string; size: number; touched: number };

/**
 * Disposable, single-process cache. Use a dedicated volume per container: the queue and in-flight map
 * coordinate this instance only. R2 remains authoritative; a cache fault can never fail its operation.
 * Only fixed-format digest filenames are used, with O_NOFOLLOW and private directory/file modes.
 */
export const createSemogPdfDiskCache = (options: SemogPdfDiskCacheOptions): SemogPdfDiskCache => {
  const maxBytes = options.maxBytes ?? 3_000_000_000;
  const idleTtlMs = options.idleTtlMs ?? 72 * 60 * 60 * 1000;
  const minFreeBytes = options.minFreeBytes ?? 5_000_000_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 30 * 60 * 1000;
  const hasValidSweep =
    Number.isSafeInteger(sweepIntervalMs) && sweepIntervalMs > 0 && sweepIntervalMs <= SEMOG_PDF_CACHE_MAX_SWEEP_MS;
  const enabled = options.enabled && hasValidSweep;
  const directory = resolve(options.directory);
  const pending = new Map<string, Promise<Uint8Array>>();
  let invalidationVersion = 0;
  let queue = Promise.resolve();
  let ready = false;
  let closed = false;
  const warn = (reason: SemogPdfDiskCacheWarning) => {
    try {
      options.onWarning?.(reason);
    } catch {
      // Telemetry is optional; a failing observer must not change storage behavior.
    }
  };
  if (options.enabled && !hasValidSweep) {
    warn('unavailable');
  }
  const filename = (key: string) => {
    const hash = semogPdfKeyHash(key);
    return hash === null ? null : `${digest(`${options.scope ?? ''}\0${key}`)}-${hash}.pdf`;
  };
  const remove = async (path: string) => {
    try {
      await fs.unlink(path);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  };
  const entries = async () => {
    const result: Entry[] = [];
    for (const name of await fs.readdir(directory)) {
      // The queue owns all active writes. Any temporary seen during a scan is an orphan,
      // including one whose cleanup failed on an earlier disk fault.
      if (TEMP.test(name)) {
        await remove(join(directory, name));
        continue;
      }
      if (!ENTRY.test(name)) {
        continue;
      }
      const path = join(directory, name);
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.mtimeMs <= Date.now() - idleTtlMs) {
        await remove(path);
      } else {
        result.push({ path, size: stat.size, touched: stat.mtimeMs });
      }
    }
    return result.sort((a, b) => a.touched - b.touched || a.path.localeCompare(b.path));
  };
  const planEviction = async (incomingBytes: number) => {
    const files = await entries();
    const planned: Entry[] = [];
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total + incomingBytes <= maxBytes) {
        break;
      }
      planned.push(file);
      total -= file.size;
    }
    return planned;
  };
  const removePlanned = async (planned: Entry[]) => {
    for (const file of planned) {
      await remove(file.path);
    }
  };
  const evict = async (incomingBytes: number) => {
    await removePlanned(await planEviction(incomingBytes));
  };
  const initialize = async () => {
    if (ready) {
      return;
    }
    if (!isAbsolute(options.directory) || directory === resolve('/')) {
      throw new Error('A dedicated absolute cache directory is required.');
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(directory)) !== directory) {
      throw new Error('Cache directory must not traverse symlinks.');
    }
    await fs.chmod(directory, 0o700);
    await evict(0);
    ready = true;
  };
  const safely = <T>(action: () => Promise<T>): Promise<T | undefined> => {
    const next = queue.then(async () => {
      try {
        await initialize();
        return await action();
      } catch {
        warn('unavailable');
        return undefined;
      }
    });
    queue = next.then(() => undefined);
    return next;
  };
  const write = async (key: string, bytes: Uint8Array) => {
    const name = filename(key);
    if (!enabled || closed || !name || bytes.byteLength > maxBytes) {
      return;
    }
    await safely(async () => {
      if (digest(bytes) !== semogPdfKeyHash(key)) {
        warn('invalid-content');
        return;
      }
      const path = join(directory, name);
      const planned = await planEviction(bytes.byteLength);
      const space = await fs.statfs(directory);
      const reclaimedBytes = planned.reduce((sum, file) => sum + file.size, 0);
      if (space.bavail * space.bsize + reclaimedBytes - bytes.byteLength < minFreeBytes) {
        warn('low-space');
        return;
      }
      await removePlanned(planned);
      if (planned.length > 0) {
        // Free space can change outside this queue, and unlink need not reclaim every estimated byte.
        const remaining = await fs.statfs(directory);
        if (remaining.bavail * remaining.bsize - bytes.byteLength < minFreeBytes) {
          warn('low-space');
          return;
        }
      }
      const temporary = join(directory, `.semog-${randomUUID()}.tmp`);
      try {
        const file = await fs.open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        await fs.rename(temporary, path);
      } finally {
        await remove(temporary);
      }
    });
  };
  const local = async (key: string) => {
    const name = filename(key);
    if (!name) {
      return undefined;
    }
    return await safely(async () => {
      const path = join(directory, name);
      let file: FileHandle;
      try {
        file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maxBytes || stat.mtimeMs <= Date.now() - idleTtlMs) {
          await remove(path);
          return undefined;
        }
        await file.chmod(0o600);
        const bytes = await file.readFile();
        if (digest(bytes) !== semogPdfKeyHash(key)) {
          await remove(path);
          warn('corrupt');
          return undefined;
        }
        const now = new Date();
        await file.utimes(now, now);
        return bytes;
      } finally {
        await file.close();
      }
    });
  };
  const loadOnce = async (key: string, load: () => Promise<Uint8Array>) => {
    const generation = invalidationVersion;
    const hit = await local(key);
    if (hit !== undefined) {
      return hit;
    }
    const bytes = await load();
    if (invalidationVersion === generation) {
      await write(key, bytes);
    }
    return bytes;
  };
  const read: SemogPdfDiskCache['read'] = async (key, load) => {
    if (!enabled || closed || !filename(key)) {
      return await load();
    }
    let current = pending.get(key);
    if (!current) {
      current = loadOnce(key, load);
      pending.set(key, current);
    }
    try {
      // Callers may mutate PDF buffers. Never share the coalesced result with them.
      return Uint8Array.from(await current);
    } finally {
      if (pending.get(key) === current) {
        pending.delete(key);
      }
    }
  };
  const invalidate = async (key: string) => {
    const name = filename(key);
    if (!enabled || closed || !name) {
      return;
    }
    // Wait for an in-flight R2 read to finish populating before removing its copy.
    invalidationVersion++;
    await pending.get(key)?.catch(() => undefined);
    await safely(() => remove(join(directory, name)));
  };
  const timer = enabled
    ? setInterval(() => {
        void safely(() => evict(0));
      }, sweepIntervalMs)
    : undefined;
  timer?.unref();
  if (enabled) {
    void safely(async () => undefined);
  }
  return {
    read,
    write,
    invalidate,
    close: () => {
      closed = true;
      clearInterval(timer);
    },
  };
};
