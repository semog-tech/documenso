import type { Prisma } from '@prisma/client';
import { DocumentDistributionMethod, DocumentSigningOrder } from '@prisma/client';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { ZSignatureFieldMeta, ZTextFieldMeta } from '../../types/field-meta';
import { nanoid, prefixedId } from '../../universal/id';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { mapDocumentIdToSecondaryId } from '../../utils/envelope';
import type { SemogDraftRequest, SemogDraftResult } from './draft-contract';
import type { SemogActor } from './service';

const createDocument = async (tx: Prisma.TransactionClient, actor: SemogActor, input: SemogDraftRequest) => {
  const counter = await tx.counter.update({ where: { id: 'document' }, data: { value: { increment: 1 } } });
  const data = await tx.documentData.create({
    data: { type: 'BYTES_64', data: input.arquivo.pdfBase64, initialData: input.arquivo.pdfBase64 },
  });
  return await tx.envelope.create({
    data: {
      id: prefixedId('envelope'),
      secondaryId: mapDocumentIdToSecondaryId(counter.value),
      externalId: input.externalId,
      title: input.titulo,
      type: 'DOCUMENT',
      source: 'DOCUMENT',
      internalVersion: 2,
      signatureLevel: 'SES',
      status: 'DRAFT',
      user: { connect: { id: actor.userId } },
      team: { connect: { id: actor.teamId } },
      visibility: 'MANAGER_AND_ABOVE',
      authOptions: { globalAccessAuth: [], globalActionAuth: [] },
      documentMeta: {
        create: {
          distributionMethod: DocumentDistributionMethod.NONE,
          language: 'pt-BR',
          timezone: 'America/Sao_Paulo',
          signingOrder:
            input.ordemAssinatura === 'sequencial' ? DocumentSigningOrder.SEQUENTIAL : DocumentSigningOrder.PARALLEL,
        },
      },
      envelopeItems: {
        create: { id: prefixedId('envelope_item'), title: input.arquivo.nome, order: 1, documentDataId: data.id },
      },
    },
    include: { envelopeItems: true },
  });
};
const createRecipient = async (
  tx: Prisma.TransactionClient,
  ids: { envelopeId: string; itemId: string },
  recipient: SemogDraftRequest['signatarios'][number],
) => {
  const created = await tx.recipient.create({
    data: {
      envelopeId: ids.envelopeId,
      name: recipient.nome,
      email: recipient.email,
      role: recipient.role,
      signingOrder: recipient.ordem,
      token: nanoid(),
      sendStatus: 'NOT_SENT',
      signingStatus: recipient.role === 'CC' ? 'SIGNED' : 'NOT_SIGNED',
      authOptions: { accessAuth: [], actionAuth: [] },
    },
  });
  const campos: SemogDraftResult['signatarios'][number]['campos'] = [];
  for (const field of recipient.campos) {
    const fieldMeta =
      field.tipo === 'SIGNATURE'
        ? ZSignatureFieldMeta.parse({ type: 'signature', required: field.obrigatorio })
        : ZTextFieldMeta.parse({
            type: 'text',
            label: field.papel === 'cpf' ? 'CPF' : 'Comentário / ressalvas',
            required: field.obrigatorio,
          });
    const result = await tx.field.create({
      data: {
        envelopeId: ids.envelopeId,
        envelopeItemId: ids.itemId,
        recipientId: created.id,
        type: field.tipo,
        page: field.pagina,
        positionX: field.x,
        positionY: field.y,
        width: field.largura,
        height: field.altura,
        customText: '',
        inserted: false,
        fieldMeta,
      },
    });
    campos.push({ referencia: field.referencia, fieldId: result.id });
  }
  return { referencia: recipient.referencia, recipientId: created.id, campos };
};
/** Stock createEnvelope cannot be used: it owns global transactions and always invokes DOCUMENT_CREATED webhook. */
export const createSemogNativeDraft = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: SemogDraftRequest,
): Promise<SemogDraftResult> => {
  const envelope = await createDocument(tx, actor, input);
  const ids = { envelopeId: envelope.id, itemId: envelope.envelopeItems[0].id };
  const signatarios: SemogDraftResult['signatarios'] = [];
  for (const recipient of input.signatarios) {
    signatarios.push(await createRecipient(tx, ids, recipient));
  }
  await tx.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_CREATED,
      envelopeId: envelope.id,
      user: { id: actor.userId },
      data: { title: input.titulo, source: { type: 'DOCUMENT' } },
    }),
  });
  return {
    operacaoId: input.operacaoId,
    envelopeId: envelope.id,
    status: 'DRAFT',
    documento: { itemId: ids.itemId, sha256: input.arquivo.sha256 },
    signatarios,
  };
};
