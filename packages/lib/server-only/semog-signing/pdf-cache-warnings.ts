import type { SemogPdfDiskCacheWarning } from './pdf-disk-cache';

/** One warning per reason per minute, per host process; fixed reasons cannot grow this map unboundedly. */
export const createSemogPdfCacheWarningObserver = (
  emit: (reason: SemogPdfDiskCacheWarning) => void,
  now = () => performance.now(),
) => {
  const lastWarnings = new Map<SemogPdfDiskCacheWarning, number>();
  return (reason: SemogPdfDiskCacheWarning) => {
    const current = now();
    const last = lastWarnings.get(reason);
    if (last !== undefined && current - last < 60_000) {
      return;
    }
    lastWarnings.set(reason, current);
    emit(reason);
  };
};
