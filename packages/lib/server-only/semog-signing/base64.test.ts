import { createHash } from 'node:crypto';
import { base64 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import { semogDraftDocumentMatches } from './activation-validation';
import { decodeSemogBase64 } from './base64';
import { createSemogPdfReader } from './initial-pdf';

const reject = (reason: string): never => {
  throw new Error(reason);
};
const invalid = [
  'YQ',
  'YWI',
  'YQ=',
  'YQ===',
  'YQ======',
  '=YQ=',
  'Y=Q=',
  '====',
  'YQ==\n',
  ' YQ==',
  'Y Q=',
  'YQ\t=',
  'YQ\0=',
  '____',
  '----',
  'Yé==',
  'YR==',
  'YWJ=',
];

describe('native strict Semog Base64', () => {
  it.each(['YQ==', 'YWI=', 'YWJj', '+/8='])('preserves exactly the canonical bytes of %s', (encoded) => {
    const bytes = decodeSemogBase64(encoded, { maximum: 3, reject });
    expect(bytes).toEqual(Buffer.from(base64.decode(encoded)));
    expect(bytes.toString('base64')).toBe(encoded);
  });
  it.each(invalid)('rejects malformed, noncanonical or nonstandard encoding %j', (encoded) => {
    expect(() => decodeSemogBase64(encoded, { maximum: 100, reject })).toThrow('invalid');
  });
  it('requires nonempty input unless the existing reader explicitly permits it', async () => {
    expect(() => decodeSemogBase64('', { maximum: 3, reject })).toThrow('invalid');
    expect(decodeSemogBase64('', { maximum: 3, reject, allowEmpty: true })).toHaveLength(0);
    await expect(createSemogPdfReader()({ documentDataId: 'd', type: 'BYTES_64', data: '' })).resolves.toHaveLength(0);
  });
  it('accepts the exact byte ceiling and rejects each size overflow before allocating a buffer', () => {
    expect(decodeSemogBase64('YQ==', { maximum: 1, reject })).toHaveLength(1);
    expect(decodeSemogBase64('YWI=', { maximum: 2, reject })).toHaveLength(2);
    expect(decodeSemogBase64('YWJj', { maximum: 3, reject })).toHaveLength(3);
    const from = vi.spyOn(Buffer, 'from');
    try {
      expect(() => decodeSemogBase64('YWI=', { maximum: 1, reject })).toThrow('decoded-limit');
      expect(() => decodeSemogBase64('YWJj', { maximum: 2, reject })).toThrow('decoded-limit');
      expect(() => decodeSemogBase64('YWJjZA==', { maximum: 3, reject })).toThrow('encoded-limit');
      expect(from).not.toHaveBeenCalled();
    } finally {
      from.mockRestore();
    }
  });
  it.each(invalid)('preserves the previous reader error for invalid stored Base64 %j', async (encoded) => {
    let previousError: unknown;
    try {
      base64.decode(encoded);
    } catch (error) {
      previousError = error;
    }
    expect(previousError).toBeInstanceOf(Error);
    await expect(createSemogPdfReader()({ documentDataId: 'd', type: 'BYTES_64', data: encoded })).rejects.toEqual(
      previousError,
    );
  });
  it.each(['', ...invalid])('keeps activation conflicts for invalid inline drafts %j', (encoded) => {
    const data = { id: 'd', type: 'BYTES_64' as const, data: encoded, initialData: encoded };
    const hash = createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex');
    expect(() => semogDraftDocumentMatches(data, hash, null)).toThrow(expect.objectContaining({ statusCode: 409 }));
  });
});
