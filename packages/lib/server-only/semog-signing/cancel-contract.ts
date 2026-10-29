import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Cancellation of a PENDING envelope the bridge activated, with the reason the Semog app recorded. */
export const ZSemogCancelRequest = z
  .object({
    chaveOperacao: z.string().uuid(),
    motivo: z.string().trim().min(1).max(500),
  })
  .strict();
export type SemogCancelRequest = z.infer<typeof ZSemogCancelRequest>;

export const ZSemogCancelResult = z
  .object({
    chaveOperacao: z.string().uuid(),
    envelopeId: z.string().min(1),
    situacao: z.literal('cancelado'),
    canceladoEm: z.string().datetime(),
    revogados: z.number().int().nonnegative(),
  })
  .strict();
export type SemogCancelResult = z.infer<typeof ZSemogCancelResult>;

/** The reason is already trimmed by the schema, so equivalent spellings hash the same. */
export const hashSemogCancel = (envelopeId: string, input: SemogCancelRequest) =>
  createHash('sha256')
    .update(JSON.stringify({ envelopeId, motivo: input.motivo }))
    .digest('hex');
