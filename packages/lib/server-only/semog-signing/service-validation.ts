import { createHash } from 'node:crypto';
import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { ZTextFieldMeta } from '../../types/field-meta';
import { ZSemogEnvelopeSnapshotSource } from './contract';
import { canonicalSemogJson } from './snapshot';

const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().positive().safe();
export const ZSemogEnrollment = z
  .object({
    envelopeId: identifier,
    recipientId: integer,
    consentimento: z.string().min(1).max(20000),
    expiraEm: z.string().datetime({ offset: true }),
  })
  .strict();
export const ZSemogManifestation = z
  .object({
    chaveOperacao: z.string().uuid(),
    envelopeId: identifier,
    recipientId: integer,
    hashDocumento: hash,
    hashConsentimento: hash,
    acao: z.enum(['assinar', 'recusar']),
    motivo: z.string().trim().min(1).max(2000).nullable(),
    campos: z.array(z.object({ fieldId: integer, valor: z.string().max(20000) }).strict()).max(200),
    assinaturaVisual: z
      .object({
        fieldId: integer,
        pngBase64: z.string().min(1).max(6990508),
        hash,
        metodo: z.enum(['desenhar', 'upload']),
      })
      .strict()
      .optional(),
    evidencias: z
      .object({
        canal: z.enum(['email', 'whatsapp']),
        metodoAutenticacao: z.enum(['link', 'codigo']).optional(),
        identificacaoId: identifier,
        confirmadoEm: z.string().datetime({ offset: true }),
        ip: z.string().ip().nullable(),
        userAgent: z.string().max(1000).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.campos.map((field) => field.fieldId)).size !== value.campos.length ||
      (value.acao === 'recusar' && (value.campos.length !== 0 || value.assinaturaVisual !== undefined)) ||
      (value.assinaturaVisual !== undefined &&
        value.campos.some((field) => field.fieldId === value.assinaturaVisual?.fieldId)) ||
      (value.acao === 'assinar' && value.motivo !== null)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Incompatible manifestation.' });
    }
  });
export type SemogManifestation = z.infer<typeof ZSemogManifestation>;
export const semogError = (code: AppErrorCode, statusCode: number) => new AppError(code, { statusCode });
export const hashSemogManifestation = (input: SemogManifestation) =>
  createHash('sha256')
    .update(
      JSON.stringify(canonicalSemogJson({ ...input, campos: [...input.campos].sort((a, b) => a.fieldId - b.fieldId) })),
    )
    .digest('hex');

export const validateSemogFieldValues = (source: unknown, input: SemogManifestation) => {
  if (input.acao === 'recusar') {
    return;
  }
  const envelope = ZSemogEnvelopeSnapshotSource.parse(source);
  const own = envelope.fields.filter((field) => field.recipientId === input.recipientId);
  if (input.assinaturaVisual) {
    const visual = input.assinaturaVisual;
    const field = own.find((candidate) => candidate.id === visual.fieldId);
    const enabled =
      visual.metodo === 'desenhar'
        ? envelope.documentMeta.drawSignatureEnabled
        : envelope.documentMeta.uploadSignatureEnabled;
    if (!field || field.type !== 'SIGNATURE' || field.inserted || !enabled) {
      throw semogError(AppErrorCode.INVALID_REQUEST, 400);
    }
  }
  for (const value of input.campos) {
    const field = own.find((candidate) => candidate.id === value.fieldId);
    if (!field || field.inserted || !['TEXT', 'SIGNATURE'].includes(field.type)) {
      throw semogError(AppErrorCode.INVALID_REQUEST, 400);
    }
    if (
      field.type === 'SIGNATURE' &&
      (value.valor.trim().length === 0 || !envelope.documentMeta.typedSignatureEnabled)
    ) {
      throw semogError(AppErrorCode.INVALID_REQUEST, 400);
    }
    if (field.type === 'TEXT') {
      const metadata = ZTextFieldMeta.parse(field.fieldMeta);
      if (
        metadata.readOnly ||
        (metadata.characterLimit !== undefined && value.valor.length > metadata.characterLimit)
      ) {
        throw semogError(AppErrorCode.INVALID_REQUEST, 400);
      }
    }
  }
  validateRequiredValues(own, input);
};

const validateRequiredValues = (
  fields: z.infer<typeof ZSemogEnvelopeSnapshotSource>['fields'],
  input: SemogManifestation,
) => {
  for (const field of fields) {
    const required =
      field.type === 'SIGNATURE' || (field.type === 'TEXT' && ZTextFieldMeta.parse(field.fieldMeta).required === true);
    if (
      required &&
      input.assinaturaVisual?.fieldId !== field.id &&
      !input.campos.some((value) => value.fieldId === field.id && value.valor.trim().length > 0)
    ) {
      throw semogError(AppErrorCode.INVALID_REQUEST, 400);
    }
  }
};
