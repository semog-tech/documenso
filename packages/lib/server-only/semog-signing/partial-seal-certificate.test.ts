import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderCertificate } from '../pdf/render-certificate';
import {
  createSemogPartialSealFixture,
  SEMOG_PARTIAL_SEAL_KEY,
  SEMOG_REPOSITORY_ROOT,
} from './partial-seal-test-fixtures';

vi.mock('../pdf/render-certificate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pdf/render-certificate')>();
  return { ...actual, renderCertificate: vi.fn(actual.renderCertificate) };
});

describe('Semog partial seal certificate input', () => {
  beforeAll(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(resolve(SEMOG_REPOSITORY_ROOT, 'apps/remix'));
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });
  it('renders without the share QR and marks only signers who did not sign, never the CC', async () => {
    const fixture = await createSemogPartialSealFixture({ withCc: true });
    expect(fixture.envelope.qrToken).not.toBeNull();
    await fixture.service.create(fixture.actor, 'env_partial', { rodada: 1, chaveOperacao: SEMOG_PARTIAL_SEAL_KEY });
    const options = vi.mocked(renderCertificate).mock.calls[0][0];
    expect(options.qrToken).toBeNull();
    const marked = options.recipients.filter((recipient) => recipient.notSigned).map((recipient) => recipient.id);
    expect(marked).toEqual([3, 4, 5]);
    const cc = options.recipients.find((recipient) => recipient.id === 6);
    expect(cc?.role).toBe('CC');
    expect(cc?.notSigned).toBeUndefined();
    expect(options.recipients.filter((recipient) => recipient.signatureField).map((recipient) => recipient.id)).toEqual(
      [1, 2],
    );
  }, 60000);
});
