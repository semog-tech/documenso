type SemogBase64Failure = 'invalid' | 'encoded-limit' | 'decoded-limit';
type SemogBase64Options = {
  maximum: number;
  reject: (reason: SemogBase64Failure) => never;
  allowEmpty?: boolean;
};

/** Native decoding is lenient; only an exact canonical round trip admits stored or submitted bytes. */
export const decodeSemogBase64 = (encoded: string, { maximum, reject, allowEmpty = false }: SemogBase64Options) => {
  if (encoded.length > 4 * Math.ceil(maximum / 3)) {
    return reject('encoded-limit');
  }
  if (encoded.length % 4 !== 0 || (!allowEmpty && encoded.length === 0)) {
    return reject('invalid');
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if ((encoded.length / 4) * 3 - padding > maximum) {
    return reject('decoded-limit');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== encoded) {
    return reject('invalid');
  }
  return bytes;
};
