import { z } from 'zod';

const identifier = z.string().uuid();
const percent = z.number().finite().min(0).max(100);
const field = z
  .object({
    referencia: identifier,
    tipo: z.enum(['TEXT', 'SIGNATURE']),
    papel: z.enum(['cpf', 'observacao', 'assinatura']),
    pagina: z.number().int().positive(),
    x: percent,
    y: percent,
    largura: percent.positive(),
    altura: percent.positive(),
    obrigatorio: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.x + value.largura > 100 ||
      value.y + value.altura > 100 ||
      (value.tipo === 'SIGNATURE') !== (value.papel === 'assinatura')
    ) {
      ctx.addIssue({ code: 'custom', message: 'Campo incompatível ou fora da página.' });
    }
  });
const recipient = z
  .object({
    referencia: identifier,
    nome: z.string().trim().min(1).max(254),
    email: z.string().trim().toLowerCase().email().max(254),
    cargo: z.string().trim().min(1).max(100).optional(),
    ordem: z.number().int().nonnegative().max(1000),
    role: z.enum(['SIGNER', 'APPROVER', 'VIEWER', 'CC', 'ASSISTANT']),
    campos: z.array(field).max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (['CC', 'VIEWER'].includes(value.role) && value.campos.length > 0) ||
      (value.role === 'ASSISTANT' && value.campos.some((item) => item.tipo === 'SIGNATURE')) ||
      (value.role === 'SIGNER' && !value.campos.some((item) => item.tipo === 'SIGNATURE' && item.obrigatorio))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Campos incompatíveis com o papel do destinatário.' });
    }
  });
const draftRequest = <T extends z.ZodTypeAny>(arquivo: T) =>
  z
    .object({
      operacaoId: identifier,
      externalId: identifier,
      versao: z.number().int().positive().safe(),
      ordemAssinatura: z.enum(['paralela', 'sequencial']),
      titulo: z.string().trim().min(1).max(500),
      arquivo,
      signatarios: z.array(recipient).min(1).max(100),
    })
    .strict()
    .superRefine((value, ctx) => {
      const recipients = value.signatarios.map((item) => item.referencia);
      const fields = value.signatarios.flatMap((item) => item.campos.map((entry) => entry.referencia));
      if (
        new Set(recipients).size !== recipients.length ||
        new Set(fields).size !== fields.length ||
        fields.length > 1000 ||
        (value.ordemAssinatura === 'paralela' && value.signatarios.some((item) => item.role === 'ASSISTANT'))
      ) {
        ctx.addIssue({ code: 'custom', message: 'Referências duplicadas ou excesso de campos.' });
      }
    });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const nome = z.string().trim().min(1).max(254);
/** Legacy JSON body: the PDF travels as canonical Base64 inside `arquivo`. */
export const ZSemogDraftRequest = draftRequest(z.object({ nome, pdfBase64: z.string().min(1), sha256 }).strict());
/** `metadados` part of the multipart body: the PDF travels as the separate `arquivo` part, raw bytes. */
export const ZSemogDraftMetadata = draftRequest(
  z.object({ nome, sha256, tamanho: z.number().int().positive().safe() }).strict(),
);
export const ZSemogDraftResult = z
  .object({
    operacaoId: identifier,
    envelopeId: z.string().min(1),
    status: z.literal('DRAFT'),
    documento: z.object({ itemId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    signatarios: z.array(
      z
        .object({
          referencia: identifier,
          recipientId: z.number().int().positive(),
          campos: z.array(z.object({ referencia: identifier, fieldId: z.number().int().positive() }).strict()),
        })
        .strict(),
    ),
  })
  .strict();
export type SemogDraftRequest = z.infer<typeof ZSemogDraftRequest>;
/** What both body formats become once the PDF is verified: the bytes are bound by hash and size, not carried. */
export type SemogDraftInput = z.infer<typeof ZSemogDraftMetadata>;
export type SemogDraftResult = z.infer<typeof ZSemogDraftResult>;
export const SEMOG_DRAFT_MAX_PDF_BYTES = 100 * 1024 * 1024;
export const semogDraftBodyLimit = (maximum: number) => 4 * Math.ceil(maximum / 3) + 512 * 1024;
