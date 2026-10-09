import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalSemogJson } from './snapshot';

export const ZSemogActivationRequest = z
  .object({
    operacaoId: z.string().uuid(),
    rascunhoOperacaoId: z.string().uuid(),
    envelopeId: z.string().min(1).max(200),
    externalId: z.string().uuid(),
    hashPdf: z.string().regex(/^[a-f0-9]{64}$/),
    expiraEm: z.string().datetime({ offset: true }),
  })
  .strict();
export const ZSemogActivationResult = ZSemogActivationRequest.pick({
  operacaoId: true,
  envelopeId: true,
  expiraEm: true,
  hashPdf: true,
})
  .extend({ status: z.literal('PENDING') })
  .strict();
export type SemogActivationRequest = z.infer<typeof ZSemogActivationRequest>;
export type SemogActivationResult = z.infer<typeof ZSemogActivationResult>;
export const hashSemogActivation = (input: SemogActivationRequest) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalSemogJson(input)))
    .digest('hex');
