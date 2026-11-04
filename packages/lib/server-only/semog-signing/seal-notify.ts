import { AppError, AppErrorCode } from '../../errors/app-error';
import { type SemogStageObserver, timeSemogStage } from './timing';

export type SemogSealNotification = { envelopeId: string; completedAt: string };
export type SemogSealNotifyResult = { envelopeId: string; status: string; ms: number };
type Dependencies = {
  env: (key: string) => string | undefined;
  observe?: SemogStageObserver;
  onResult: (result: SemogSealNotifyResult) => void;
};
const TIMEOUT_MS = 1500;
const MAX_CONCURRENT = 2;

const postNotification = async (url: string, token: string, body: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
    return {
      status: response.ok ? 'delivered' : `http-${response.status}`,
      retry: response.status >= 500 && response.status <= 599,
    };
  } catch {
    return { status: controller.signal.aborted ? 'timeout' : 'network-error', retry: true };
  } finally {
    clearTimeout(timer);
    // No response body is needed. Abort also releases streaming/unbounded response bodies.
    controller.abort();
  }
};

/** Lossy hint only: two active deliveries per host, no queue, no durable effect and no awaited caller. */
export const createSemogSealNotifier = ({ env, observe, onResult }: Dependencies) => {
  const url = env('SEMOG_SELAGEM_AVISO_URL');
  const token = env('SEMOG_SELAGEM_AVISO_TOKEN');
  if (!url || !token) {
    return undefined;
  }
  let active = 0;
  const report = (result: SemogSealNotifyResult) => {
    try {
      onResult(result);
    } catch {
      // Logging must never affect completion or create an unhandled rejection.
      return;
    }
  };
  return (notification: SemogSealNotification): void => {
    if (active >= MAX_CONCURRENT) {
      report({ envelopeId: notification.envelopeId, status: 'skipped-busy', ms: 0 });
      return;
    }
    active++;
    const started = performance.now();
    let status = 'network-error';
    void timeSemogStage(observe, 'seal.notify', async () => {
      const body = JSON.stringify(notification);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await postNotification(url, token, body);
        status = result.status;
        if (status === 'delivered') {
          return;
        }
        if (!result.retry) {
          break;
        }
      }
      throw new AppError(AppErrorCode.UNKNOWN_ERROR);
    })
      .catch(() => undefined)
      .finally(() => {
        active--;
        report({ envelopeId: notification.envelopeId, status, ms: Math.round(performance.now() - started) });
      });
  };
};
