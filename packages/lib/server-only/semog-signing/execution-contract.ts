import { z } from 'zod';

export const ZSemogExecutionResult = z
  .object({
    chaveOperacao: z.string().uuid(),
    envelopeId: z.string(),
    recipientId: z.number().int().positive(),
    hashDocumento: z.string().regex(/^[a-f0-9]{64}$/),
    hashConsentimento: z.string().regex(/^[a-f0-9]{64}$/),
    acao: z.enum(['assinar', 'recusar']),
    situacao: z.enum(['pendente', 'concluida']),
    documentoConcluido: z.boolean(),
    pdfDisponivel: z.boolean(),
  })
  .strict()
  .refine(
    (result) =>
      (!result.pdfDisponivel || result.documentoConcluido) &&
      (!result.documentoConcluido || (result.acao === 'assinar' && result.situacao === 'concluida')),
  );
export type SemogExecutionResult = z.infer<typeof ZSemogExecutionResult>;
export const ZSemogExecutionOperation = z.object({
  chaveOperacao: z.string().uuid(),
  snapshotId: z.string().uuid(),
  teamId: z.number().int().positive(),
  envelopeId: z.string(),
  recipientId: z.number().int().positive(),
  hashDocumento: z.string(),
  hashConsentimento: z.string(),
  hashPedido: z.string(),
  pedido: z.unknown(),
  acao: z.enum(['assinar', 'recusar']),
  estado: z.enum(['pendente', 'concluida']),
  resultado: ZSemogExecutionResult.nullable(),
  execucao: z.record(z.unknown()).nullable(),
});
export type SemogExecutionOperation = z.infer<typeof ZSemogExecutionOperation>;
