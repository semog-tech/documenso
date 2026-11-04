import { describe, expect, it, vi } from 'vitest';
import { timeSemogStage } from './timing';

describe('Semog timing is observational', () => {
  it('preserves a successful result even when the observer fails', async () => {
    const value = { done: true };
    const observer = vi.fn(() => {
      throw new Error('telemetry failed');
    });
    expect(await timeSemogStage(observer, 'seal.total', () => value)).toBe(value);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith({ stage: 'seal.total', ms: expect.any(Number), ok: true });
  });

  it('preserves the original failure and reports the failed stage without data', async () => {
    const original = new Error('signer failed');
    const observer = vi.fn(() => {
      throw new Error('telemetry failed');
    });
    await expect(
      timeSemogStage(observer, 'seal.sign', () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith({ stage: 'seal.sign', ms: expect.any(Number), ok: false });
  });
});
