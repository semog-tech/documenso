import type { SemogPdfDiskCacheOptions } from './pdf-disk-cache';
import { SEMOG_PDF_CACHE_MAX_SWEEP_MS } from './pdf-disk-cache';

/** Invalid cache configuration disables this disposable optimization, never the bridge. */
export const semogPdfDiskCacheOptionsFromEnv = (
  read: (name: string) => string | undefined,
  scope: string,
  onWarning: NonNullable<SemogPdfDiskCacheOptions['onWarning']>,
): SemogPdfDiskCacheOptions => {
  const options: SemogPdfDiskCacheOptions = {
    enabled: read('SEMOG_PDF_CACHE_ENABLED') === 'true',
    directory: read('SEMOG_PDF_CACHE_DIRECTORY') || '/var/cache/semog-pdf',
    scope,
    onWarning,
  };
  const settings = [
    ['SEMOG_PDF_CACHE_MAX_BYTES', 'maxBytes', 1],
    ['SEMOG_PDF_CACHE_IDLE_TTL_HOURS', 'idleTtlMs', 60 * 60 * 1000],
    ['SEMOG_PDF_CACHE_MIN_FREE_BYTES', 'minFreeBytes', 1],
    ['SEMOG_PDF_CACHE_SWEEP_MINUTES', 'sweepIntervalMs', 60 * 1000],
  ] as const;
  for (const [name, property, multiplier] of settings) {
    const value = read(name);
    if (value === undefined) {
      continue;
    }
    const numeric = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(numeric * multiplier) ||
      numeric <= 0 ||
      (property === 'sweepIntervalMs' && numeric * multiplier > SEMOG_PDF_CACHE_MAX_SWEEP_MS)
    ) {
      options.enabled = false;
      onWarning('unavailable');
      return options;
    }
    options[property] = numeric * multiplier;
  }
  return options;
};
