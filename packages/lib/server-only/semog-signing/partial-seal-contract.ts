import { z } from 'zod';

/** Rounds are counted by the Semog app; the bridge only binds them to one key and one sealed PDF. */
export const ZSemogPartialSealRequest = z
  .object({
    rodada: z.number().int().min(1).max(1000),
    chaveOperacao: z.string().uuid(),
  })
  .strict();
export type SemogPartialSealRequest = z.infer<typeof ZSemogPartialSealRequest>;

export const ZSemogPartialSealSigner = z
  .object({
    recipientId: z.number().int().positive(),
    nome: z.string(),
    email: z.string(),
    assinou: z.boolean(),
    assinadoEm: z.string().nullable(),
  })
  .strict();
export type SemogPartialSealSigner = z.infer<typeof ZSemogPartialSealSigner>;
export const ZSemogPartialSealSigners = z.array(ZSemogPartialSealSigner).min(1);

export const ZSemogPartialSealResult = z
  .object({
    chaveOperacao: z.string().uuid(),
    envelopeId: z.string().min(1),
    rodada: z.number().int().min(1),
    hashPdf: z.string().regex(/^[a-f0-9]{64}$/),
    assinados: z.number().int().min(0),
    total: z.number().int().min(1),
    assinantes: ZSemogPartialSealSigners,
    criadoEm: z.string(),
  })
  .strict();
export type SemogPartialSealResult = z.infer<typeof ZSemogPartialSealResult>;

const recifeDay = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Recife',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
/** Stamp drawn on every page; the date is the Recife calendar day (UTC-3) of the seal. */
export const semogPartialSealLabel = (signed: number, total: number, now: Date) =>
  `SELO PARCIAL · ${signed} de ${total} · ${recifeDay.format(now)}`;
