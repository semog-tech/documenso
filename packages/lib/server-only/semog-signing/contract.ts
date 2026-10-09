import { z } from 'zod';

export type SemogJson = null | boolean | number | string | SemogJson[] | { [key: string]: SemogJson };
export type SemogJsonObject = { [key: string]: SemogJson };
export type SemogSnapshot = {
  id: string;
  teamId: number;
  envelopeId: string;
  recipientId: number;
  hashDocumento: string;
  hashConsentimento: string;
  hashSnapshot: string;
  expiraEm: string;
  conteudo: SemogJsonObject;
};

const id = z.string().min(1);
const integer = z.number().int().positive();
const date = z
  .union([z.string().datetime({ offset: true }), z.date()])
  .transform((value) => new Date(value).toISOString());
const decimal = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]);
const auth = (accessKey: string, actionKey: string) =>
  z
    .object({
      [accessKey]: z.array(z.string()).max(0),
      [actionKey]: z.array(z.string()).max(0),
    })
    .strict()
    .nullable();

export const ZSemogEnvelopeSnapshotSource = z.object({
  id,
  teamId: integer,
  title: z.string(),
  type: z.literal('DOCUMENT'),
  internalVersion: z.literal(2),
  status: z.literal('PENDING'),
  signatureLevel: z.literal('SES'),
  useLegacyFieldInsertion: z.literal(false),
  deletedAt: z.null(),
  authOptions: auth('globalAccessAuth', 'globalActionAuth'),
  envelopeAttachments: z.array(z.unknown()).max(0),
  documentMeta: z
    .object({
      signingOrder: z.enum(['PARALLEL', 'SEQUENTIAL']),
      allowDictateNextSigner: z.literal(false),
      typedSignatureEnabled: z.boolean(),
      uploadSignatureEnabled: z.boolean(),
      drawSignatureEnabled: z.boolean(),
      language: id,
      timezone: z.string().nullable(),
      dateFormat: z.string().nullable(),
      distributionMethod: z.enum(['EMAIL', 'NONE']),
    })
    .passthrough(),
  envelopeItems: z
    .array(
      z.object({
        id,
        envelopeId: id,
        title: z.string(),
        order: z.number().int().nonnegative(),
        documentDataId: id,
        documentData: z.object({ id, initialData: id }),
      }),
    )
    .length(1),
  recipients: z
    .array(
      z.object({
        id: integer,
        envelopeId: id,
        email: z.string().email(),
        name: z.string(),
        token: id,
        role: z.enum(['SIGNER', 'CC', 'VIEWER', 'APPROVER', 'ASSISTANT']),
        signingStatus: z.enum(['NOT_SIGNED', 'SIGNED', 'REJECTED']),
        signingOrder: z.number().int().nonnegative().nullable(),
        signedAt: date.nullable(),
        expiresAt: date.nullable(),
        documentDeletedAt: date.nullable(),
        authOptions: auth('accessAuth', 'actionAuth'),
      }),
    )
    .min(1),
  fields: z
    .array(
      z.object({
        id: integer,
        envelopeId: id,
        envelopeItemId: id,
        recipientId: integer,
        type: z.enum([
          'SIGNATURE',
          'FREE_SIGNATURE',
          'INITIALS',
          'NAME',
          'EMAIL',
          'DATE',
          'TEXT',
          'NUMBER',
          'RADIO',
          'CHECKBOX',
          'DROPDOWN',
        ]),
        page: integer,
        positionX: decimal,
        positionY: decimal,
        width: decimal,
        height: decimal,
        customText: z.string(),
        inserted: z.boolean(),
        fieldMeta: z.unknown(),
      }),
    )
    .min(1),
});

export type SemogEnvelopeSnapshotSource = z.infer<typeof ZSemogEnvelopeSnapshotSource>;
