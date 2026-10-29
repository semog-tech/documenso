import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Deadline extension of recipients who did not sign, ahead of a new enrollment round. */
export const ZSemogExtensionRequest = z
  .object({
    chaveOperacao: z.string().uuid(),
    recipientIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
    expiraEm: z.string().datetime({ offset: true }),
  })
  .strict();
export type SemogExtensionRequest = z.infer<typeof ZSemogExtensionRequest>;

export const ZSemogExtensionResult = z
  .object({
    chaveOperacao: z.string().uuid(),
    envelopeId: z.string().min(1),
    recipientIds: z.array(z.number().int().positive()).min(1),
    expiraEm: z.string().datetime(),
    snapshotsRevogados: z.number().int().min(0),
  })
  .strict();
export type SemogExtensionResult = z.infer<typeof ZSemogExtensionResult>;

/** Order and offset notation do not change the request: ids are sorted and the instant is normalized to UTC. */
export const normalizeSemogExtension = (envelopeId: string, input: SemogExtensionRequest) => {
  const recipientIds = [...input.recipientIds].sort((a, b) => a - b);
  const expiraEm = new Date(input.expiraEm).toISOString();
  const hash = createHash('sha256').update(JSON.stringify({ envelopeId, recipientIds, expiraEm })).digest('hex');
  return { recipientIds, expiraEm, hash };
};
