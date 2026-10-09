import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { semogAuthenticationLabel, semogAuthenticationMethod } from './auth-evidence';
import { serviceFixture } from './service-test-fixtures';
import { hashSemogManifestation, ZSemogManifestation } from './service-validation';
import { canonicalSemogJson } from './snapshot';

describe('Semog authentication evidence', () => {
  it('preserves old durable request hashes and infers their original code authentication', async () => {
    const fixture = serviceFixture();
    const historical = createHash('sha256')
      .update(JSON.stringify(canonicalSemogJson(fixture.input)))
      .digest('hex');
    const parsed = ZSemogManifestation.parse(fixture.input);
    expect(parsed.evidencias.metodoAutenticacao).toBeUndefined();
    expect(hashSemogManifestation(parsed)).toBe(historical);
    expect(semogAuthenticationMethod(parsed.evidencias)).toBe('codigo');
    await fixture.service.reserve(fixture.actor, fixture.input);
    expect(fixture.repository.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        hashPedido: historical,
        pedido: fixture.input,
        evidencias: { ...fixture.input.evidencias, metodoAutenticacao: 'codigo' },
      }),
    );
  });

  it.each([
    'link',
    'codigo',
  ] as const)('binds explicit %s to durable evidence and rejects switching on replay', async (method) => {
    const fixture = serviceFixture();
    const input = {
      ...fixture.input,
      evidencias: { ...fixture.input.evidencias, metodoAutenticacao: method },
    };
    await fixture.service.reserve(fixture.actor, input);
    const reserved = await fixture.repository.reserveOperation.mock.results[0].value;
    fixture.repository.getOperation.mockResolvedValue(reserved);
    await expect(fixture.service.reserve(fixture.actor, input)).resolves.toMatchObject({ situacao: 'pendente' });
    await expect(
      fixture.service.reserve(fixture.actor, {
        ...input,
        evidencias: { ...input.evidencias, metodoAutenticacao: method === 'link' ? 'codigo' : 'link' },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.repository.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({ pedido: input, evidencias: input.evidencias }),
    );
  });

  it('distinguishes link possession from code verification on both certificate channels', () => {
    for (const canal of ['email', 'whatsapp'] as const) {
      const channel = canal === 'email' ? 'e-mail' : 'WhatsApp';
      expect(semogAuthenticationLabel({ canal, metodoAutenticacao: 'link' })).toBe(`Link enviado por ${channel}`);
      expect(semogAuthenticationLabel({ canal, metodoAutenticacao: 'codigo' })).toBe(`Código por ${channel}`);
      expect(semogAuthenticationLabel({ canal })).toBe(`Código por ${channel}`);
    }
    const fixture = serviceFixture();
    expect(() =>
      ZSemogManifestation.parse({
        ...fixture.input,
        evidencias: { ...fixture.input.evidencias, metodoAutenticacao: 'otp-inventado' },
      }),
    ).toThrow();
  });
});
