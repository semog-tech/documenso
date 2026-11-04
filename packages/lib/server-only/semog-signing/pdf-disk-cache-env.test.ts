import { describe, expect, it, vi } from 'vitest';

import { semogPdfDiskCacheOptionsFromEnv } from './pdf-disk-cache-env';

describe('Semog PDF cache environment', () => {
  it('requires opt-in, accepts bounded values, and keeps private defaults', () => {
    expect(semogPdfDiskCacheOptionsFromEnv(() => undefined, 'bucket', vi.fn())).toMatchObject({
      enabled: false,
      directory: '/var/cache/semog-pdf',
    });
    const values: Record<string, string> = {
      SEMOG_PDF_CACHE_ENABLED: 'true',
      SEMOG_PDF_CACHE_MAX_BYTES: '3000000000',
      SEMOG_PDF_CACHE_IDLE_TTL_HOURS: '72',
      SEMOG_PDF_CACHE_MIN_FREE_BYTES: '5000000000',
      SEMOG_PDF_CACHE_SWEEP_MINUTES: '30',
    };
    expect(semogPdfDiskCacheOptionsFromEnv((name) => values[name], 'bucket', vi.fn())).toMatchObject({
      enabled: true,
      maxBytes: 3_000_000_000,
      idleTtlMs: 72 * 60 * 60 * 1000,
      minFreeBytes: 5_000_000_000,
      sweepIntervalMs: 30 * 60 * 1000,
    });
  });
  it.each(['', '-1', 'NaN', 'Infinity', '0', '9007199254740992'])('disables invalid limits: %s', (value) => {
    const warn = vi.fn();
    const options = semogPdfDiskCacheOptionsFromEnv(
      (name) =>
        name === 'SEMOG_PDF_CACHE_ENABLED' ? 'true' : name === 'SEMOG_PDF_CACHE_MAX_BYTES' ? value : undefined,
      'bucket',
      warn,
    );
    expect(options.enabled).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
  it.each([
    ['35791', true],
    ['35792', false],
  ] as const)('bounds sweep minutes to the Node timer limit: %s', (minutes, enabled) => {
    const warn = vi.fn();
    const options = semogPdfDiskCacheOptionsFromEnv(
      (name) =>
        name === 'SEMOG_PDF_CACHE_ENABLED' ? 'true' : name === 'SEMOG_PDF_CACHE_SWEEP_MINUTES' ? minutes : undefined,
      'bucket',
      warn,
    );
    expect(options.enabled).toBe(enabled);
    expect(warn).toHaveBeenCalledTimes(enabled ? 0 : 1);
    if (enabled) {
      expect(options.sweepIntervalMs).toBe(35791 * 60 * 1000);
    }
  });
});
