import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Correction of a missing signer's e-mail on a sent envelope. Name changes are out of scope. */
export const ZSemogContactRequest = z
  .object({
    chaveOperacao: z.string().uuid(),
    recipientId: z.number().int().positive(),
    email: z.string().trim().toLowerCase().max(254).email(),
  })
  .strict();
export type SemogContactRequest = z.infer<typeof ZSemogContactRequest>;

export const ZSemogContactResult = z
  .object({
    chaveOperacao: z.string().uuid(),
    envelopeId: z.string().min(1),
    recipientId: z.number().int().positive(),
    email: z.string().email(),
    revogados: z.array(z.number().int().positive()),
    reinscritos: z.array(z.number().int().positive()),
  })
  .strict();
export type SemogContactResult = z.infer<typeof ZSemogContactResult>;

/** The e-mail is already trimmed and lowercased by the schema, so equivalent spellings hash the same. */
export const hashSemogContact = (envelopeId: string, input: SemogContactRequest) =>
  createHash('sha256')
    .update(JSON.stringify({ envelopeId, recipientId: input.recipientId, email: input.email }))
    .digest('hex');
