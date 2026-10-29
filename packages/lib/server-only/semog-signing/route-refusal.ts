import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError, AppErrorCode } from '../../errors/app-error';

/** Stable, sanitized 409 detail for per-envelope bridge routes: a code and, when per recipient, who and why. */
export const ZSemogRefusal = z
  .object({
    codigo: z.enum([
      'chave-reutilizada',
      'rodada-ja-selada',
      'envelope-nao-pendente',
      'envelope-com-recusa',
      'prazo-no-passado',
      'destinatarios-inelegiveis',
    ]),
    destinatarios: z
      .array(
        z
          .object({
            recipientId: z.number().int(),
            motivo: z.enum([
              'nao-encontrado',
              'nao-signatario',
              'ja-assinou',
              'operacao-existente',
              'sem-prazo',
              'prazo-nao-avanca',
              'inscricao-vigente',
            ]),
          })
          .strict(),
      )
      .min(1)
      .optional(),
  })
  .strict();
export type SemogRefusal = z.infer<typeof ZSemogRefusal>;
export type SemogRefusedRecipient = NonNullable<SemogRefusal['destinatarios']>[number];

export const semogRefusal = (refusal: SemogRefusal) =>
  Object.assign(new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 }), {
    semogRefusal: ZSemogRefusal.parse(refusal),
  });

/** Only a validated refusal is ever echoed to the caller; anything else stays a bare 409/503. */
export const readSemogRefusal = (error: unknown): SemogRefusal | null => {
  if (!(error instanceof AppError) || !('semogRefusal' in error)) {
    return null;
  }
  const parsed = ZSemogRefusal.safeParse(error.semogRefusal);
  return parsed.success ? parsed.data : null;
};

/** A receipt key already committed by a concurrent request (possibly for another envelope). */
export const isSemogUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  (error.code === 'P2002' || (error.code === 'P2010' && String(error.meta?.code) === '23505'));
