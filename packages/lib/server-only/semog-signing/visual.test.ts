import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { serviceFixture } from './service-test-fixtures';
import { hashSemogManifestation, validateSemogFieldValues, ZSemogManifestation } from './service-validation';
import { validateSemogVisualSignature } from './visual';

describe('visual signature contract', () => {
  it('binds decoded PNG bytes and keeps a signature image out of textual fields', async () => {
    const fixture = serviceFixture();
    fixture.envelope.documentMeta.drawSignatureEnabled = true;
    const png = await sharp({
      create: { width: 120, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const visual = {
      fieldId: 20,
      pngBase64: png.toString('base64'),
      hash: createHash('sha256').update(png).digest('hex'),
      metodo: 'desenhar',
    };
    const input = ZSemogManifestation.parse({ ...fixture.input, campos: [], assinaturaVisual: visual });
    await expect(validateSemogVisualSignature(input)).resolves.toBeUndefined();
    expect(() => validateSemogFieldValues(fixture.envelope, input)).not.toThrow();
    expect(hashSemogManifestation(input)).not.toBe(
      hashSemogManifestation({ ...input, assinaturaVisual: { ...visual, metodo: 'upload' } }),
    );
    await expect(
      validateSemogVisualSignature(
        ZSemogManifestation.parse({ ...input, assinaturaVisual: { ...visual, hash: 'a'.repeat(64) } }),
      ),
    ).rejects.toThrow();
    expect(() => ZSemogManifestation.parse({ ...input, campos: [{ fieldId: 20, valor: 'placeholder' }] })).toThrow();
  });
  it('rejects malformed PNG and a disabled method before storage', async () => {
    const fixture = serviceFixture();
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'black' } })
      .png()
      .toBuffer();
    const input = ZSemogManifestation.parse({
      ...fixture.input,
      campos: [],
      assinaturaVisual: {
        fieldId: 20,
        pngBase64: png.toString('base64'),
        hash: createHash('sha256').update(png).digest('hex'),
        metodo: 'upload',
      },
    });
    expect(() => validateSemogFieldValues(fixture.envelope, input)).toThrow();
    const fake = Buffer.from('not a png');
    await expect(
      validateSemogVisualSignature(
        ZSemogManifestation.parse({
          ...input,
          assinaturaVisual: {
            ...input.assinaturaVisual,
            pngBase64: fake.toString('base64'),
            hash: createHash('sha256').update(fake).digest('hex'),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
