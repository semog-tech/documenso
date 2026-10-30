/** Manifestation stages measured for the host log. Carries no person, token or document data. */
export type SemogStage =
  | 'manifestation'
  | 'reserve.read'
  | 'reserve.snapshot'
  | 'execute.read'
  | 'execute.pdf'
  | 'execute.transaction';
export type SemogStageTiming = {
  stage: SemogStage;
  ms: number;
  ok: boolean;
  bytes?: number;
  attempts?: number;
};
export type SemogStageObserver = (timing: SemogStageTiming) => void;
type Details = Pick<SemogStageTiming, 'bytes' | 'attempts'>;

/** Reports the stage either way and rethrows untouched: measuring never changes the outcome. */
export const timeSemogStage = async <T>(
  observe: SemogStageObserver | undefined,
  stage: SemogStage,
  run: () => T | Promise<T>,
  details?: (value: T) => Details,
): Promise<T> => {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const value = await run();
    observe?.({ stage, ms: elapsed(), ok: true, ...details?.(value) });
    return value;
  } catch (error) {
    observe?.({ stage, ms: elapsed(), ok: false });
    throw error;
  }
};
