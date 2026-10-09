import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ZSemogEnvelopeSnapshotSource } from './contract';
import { applySemogNativeManifestation } from './native-mutations';
import { serviceFixture } from './service-test-fixtures';
import { ZSemogManifestation } from './service-validation';

describe('native audit authentication metadata', () => {
  it.each([
    'link',
    'codigo',
    undefined,
  ] as const)('records %s without asserting native 2FA for signatures or refusals', async (method) => {
    for (const acao of ['assinar', 'recusar'] as const) {
      const fixture = serviceFixture();
      const input = ZSemogManifestation.parse({
        ...fixture.input,
        acao,
        campos: acao === 'assinar' ? fixture.input.campos : [],
        evidencias: {
          ...fixture.input.evidencias,
          ...(method === undefined ? {} : { metodoAutenticacao: method }),
        },
      });
      const create = vi
        .fn<(input: { data: { type: string; data: unknown } }) => Promise<{ id: string }>>()
        .mockResolvedValue({ id: 'audit-local' });
      const writes = {
        documentAuditLog: { create },
        recipient: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        field: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        signature: { upsert: vi.fn().mockResolvedValue({}) },
      };
      // The injected test double implements precisely the writes exercised by this unit.
      const tx = writes as unknown as Prisma.TransactionClient;
      // Native mutation only reads fields from this snapshot fixture; no other ORM data is accessed.
      const envelope = {
        ...fixture.envelope,
        fields: fixture.envelope.fields.map((field) => ({ ...field, secondaryId: `field_${field.id}` })),
      } as unknown as Parameters<typeof applySemogNativeManifestation>[1];
      const recipient = ZSemogEnvelopeSnapshotSource.parse(fixture.envelope).recipients[0];
      await applySemogNativeManifestation(tx, envelope, input, recipient);
      expect(create).toHaveBeenCalled();
      for (const [call] of create.mock.calls) {
        const data = z.object({ semog: z.unknown(), actionAuth: z.array(z.string()).optional() }).parse(call.data.data);
        expect(data.semog).toEqual({
          canal: input.evidencias.canal,
          metodoAutenticacao: method ?? 'codigo',
          identificacaoId: input.evidencias.identificacaoId,
          confirmadoEm: input.evidencias.confirmadoEm,
        });
        expect(call.data.type).not.toMatch(/AUTH_2FA/);
        if (call.data.type === 'DOCUMENT_RECIPIENT_COMPLETED') {
          expect(data.actionAuth).toEqual([]);
        }
      }
    }
  });
});
