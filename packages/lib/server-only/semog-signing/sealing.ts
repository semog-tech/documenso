import { createHash, randomUUID } from 'node:crypto';
import type { FieldWithSignature } from '@documenso/prisma/types/field-with-signature';
import type { Color, EmbeddedFont, PDFPage, Signer } from '@libpdf/core';
import { PDF, rgb } from '@libpdf/core';
import type { I18n } from '@lingui/core';
import { Prisma } from '@prisma/client';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { ZDocumentAuditLogEventDocumentCompletedSchema } from '../../types/document-audit-logs';
import { insertFieldInPDFV2 } from '../pdf/insert-field-in-pdf-v2';
import type { SemogDocumentI18n } from './document-pages';
import { renderSemogDocumentPages } from './document-pages';
import type { SemogPrismaTransactionRunner } from './execution';
import type { SemogPdfReader } from './initial-pdf';
import type { SemogActor } from './service';

type Dependencies = {
  enabled?: boolean;
  client: SemogPrismaTransactionRunner;
  readPdf: SemogPdfReader;
  signer?: Signer;
  rejectionFont?: Uint8Array;
  getDocumentI18n?: SemogDocumentI18n;
};
const denied = () => new AppError(AppErrorCode.INVALID_REQUEST, { statusCode: 409 });
type DiagonalStamp = {
  title: string;
  color: Color;
  size: (font: EmbeddedFont, page: PDFPage) => number;
  /** Omitted for the native rejection stamp, which stays fully opaque. */
  opacity?: number;
};
/** Native rejection stamp geometry, with host-supplied Noto Sans instead of the native localhost fetch. */
const drawDiagonalStamp = (pdf: PDF, fontBytes: Uint8Array, stamp: DiagonalStamp) => {
  const font = pdf.embedFont(fontBytes);
  for (const page of pdf.getPages()) {
    const size = stamp.size(font, page),
      width = font.getTextWidth(stamp.title, size),
      x = page.width / 2,
      y = page.height / 2;
    page.drawRectangle({
      x: x - (width + 20) / 2,
      y: y - (size + 20) / 4,
      width: width + 20,
      height: size + 20,
      borderColor: stamp.color,
      borderWidth: 4,
      borderOpacity: stamp.opacity,
      rotate: { angle: 45, origin: 'center' },
    });
    page.drawText(stamp.title, {
      x: x - width / 2,
      y,
      size,
      font,
      color: stamp.color,
      opacity: stamp.opacity,
      rotate: { angle: 45, origin: 'center' },
    });
  }
};
/** Same v2 field renderer and PDF signing library as the native sealer, with an injected certificate. */
const stampRejected = (pdf: PDF, fontBytes: Uint8Array) =>
  drawDiagonalStamp(pdf, fontBytes, {
    title: 'DOCUMENT REJECTED',
    color: rgb(220 / 255, 38 / 255, 38 / 255),
    size: () => 36,
  });
/**
 * Rejection geometry; the longer label shrinks so its 45° box stays inside the smaller page side, and is
 * translucent so the certificate rows underneath stay legible.
 */
export const stampSemogPartialSeal = (pdf: PDF, fontBytes: Uint8Array, title: string) =>
  drawDiagonalStamp(pdf, fontBytes, {
    title,
    color: rgb(180 / 255, 83 / 255, 9 / 255),
    opacity: 0.6,
    size: (font, page) =>
      Math.min(36, (Math.min(page.width, page.height) * 0.9 * Math.SQRT2 - 20) / font.getTextWidth(title, 1)),
  });
const pagePosition = (page: PDFPage) => {
  const coordinates: Record<number, { x: number; y: number }> = {
    0: { x: 0, y: 0 },
    90: { x: page.height, y: 0 },
    180: { x: page.width, y: page.height },
    270: { x: 0, y: page.width },
  };
  const position = coordinates[page.rotation];
  if (!position) {
    throw denied();
  }
  return position;
};
const insertNativeFieldPages = async (pdf: PDF, fields: FieldWithSignature[]) => {
  const pages = [...new Set(fields.filter((field) => field.inserted).map((field) => field.page))];
  for (const number of pages) {
    const page = pdf.getPage(number - 1);
    if (!page) {
      throw denied();
    }
    const overlay = await PDF.load(
      await insertFieldInPDFV2({
        pageWidth: page.width,
        pageHeight: page.height,
        fields: fields.filter((field) => field.page === number && field.inserted),
      }),
    );
    const embedded = await pdf.embedPage(overlay, 0);
    page.drawPage(embedded, { ...pagePosition(page), rotate: { angle: page.rotation } });
  }
};
type DecorateOptions = {
  fields: FieldWithSignature[];
  signer: Signer;
  rejectionFont: Uint8Array | null;
  documentPages: Uint8Array[];
  /** Runs after the appendix and fields, so it reaches every page of the sealed PDF. */
  stampAllPages?: (pdf: PDF) => void;
};
export const decorateSemogPdf = async (bytes: Uint8Array, options: DecorateOptions) => {
  const pdf = await PDF.load(bytes);
  pdf.flattenAll();
  pdf.upgradeVersion('1.7');
  if (options.rejectionFont !== null) {
    stampRejected(pdf, options.rejectionFont);
  }
  for (const page of options.documentPages) {
    const appendix = await PDF.load(page);
    await pdf.copyPagesFrom(
      appendix,
      Array.from({ length: appendix.getPageCount() }, (_, index) => index),
    );
  }
  await insertNativeFieldPages(pdf, options.fields);
  options.stampAllPages?.(pdf);
  pdf.flattenAll();
  const normalized = await PDF.load(await pdf.save({ useXRefStream: true }));
  return (
    await normalized.sign({ signer: options.signer, reason: 'Signed by Documenso', subFilter: 'ETSI.CAdES.detached' })
  ).bytes;
};

export const readSemogSealingEnvelope = async (tx: Prisma.TransactionClient, actor: SemogActor, envelopeId: string) => {
  const lock = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM public."Envelope" WHERE id=${envelopeId} AND "teamId"=${actor.teamId} FOR UPDATE`,
  );
  if (lock.length !== 1) {
    throw new AppError(AppErrorCode.NOT_FOUND, { statusCode: 404 });
  }
  return await tx.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: {
      recipients: true,
      documentMeta: true,
      user: { select: { name: true, email: true } },
      fields: { include: { signature: true } },
      envelopeItems: { include: { documentData: true } },
    },
  });
};
export type SemogSealingEnvelope = Awaited<ReturnType<typeof readSemogSealingEnvelope>>;
type NativeEnvelope = SemogSealingEnvelope;
const assertSealable = (dependencies: Dependencies, envelope: NativeEnvelope) => {
  const rejected = envelope.recipients.some((recipient) => recipient.signingStatus === 'REJECTED');
  if (rejected && !dependencies.rejectionFont) {
    throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
  }
  if (
    envelope.status !== 'PENDING' ||
    envelope.internalVersion !== 2 ||
    envelope.signatureLevel !== 'SES' ||
    envelope.useLegacyFieldInsertion ||
    (!rejected &&
      envelope.recipients.some((recipient) => recipient.role !== 'CC' && recipient.signingStatus !== 'SIGNED'))
  ) {
    throw denied();
  }
  return rejected;
};
const createItemPdf = async (
  tx: Prisma.TransactionClient,
  dependencies: Dependencies,
  envelope: NativeEnvelope,
  signer: Signer,
  rejected: boolean,
  i18n: I18n,
  item: NativeEnvelope['envelopeItems'][number],
) => {
  const pdf = await dependencies.readPdf({
    documentDataId: item.documentData.id,
    type: item.documentData.type,
    data: item.documentData.initialData,
  });
  const original = await PDF.load(pdf);
  const lastPage = original.getPage(original.getPageCount() - 1);
  if (!lastPage) {
    throw denied();
  }
  const documentPages = await renderSemogDocumentPages(
    tx,
    { ...envelope, status: rejected ? 'REJECTED' : 'COMPLETED' },
    { width: lastPage.width, height: lastPage.height },
    i18n,
  );
  return await decorateSemogPdf(pdf, {
    fields: envelope.fields.filter((field) => field.envelopeItemId === item.id),
    signer,
    rejectionFont: rejected ? (dependencies.rejectionFont ?? null) : null,
    documentPages,
  });
};
const persistSealedItems = async (
  tx: Prisma.TransactionClient,
  dependencies: Dependencies,
  envelope: NativeEnvelope,
  signer: Signer,
  rejected: boolean,
  i18n: I18n,
) => {
  for (const item of envelope.envelopeItems) {
    const signed = await createItemPdf(tx, dependencies, envelope, signer, rejected, i18n, item);
    const data = await tx.documentData.create({
      data: {
        type: 'BYTES_64',
        data: Buffer.from(signed).toString('base64'),
        initialData: item.documentData.initialData,
      },
    });
    await tx.envelopeItem.update({ where: { id: item.id }, data: { documentDataId: data.id } });
    const receipt = { documentDataId: data.id, hashPdf: createHash('sha256').update(signed).digest('hex') };
    await tx.$executeRaw(Prisma.sql`UPDATE semog_bridge.operations SET execucao=jsonb_set(execucao,'{selagem}',${JSON.stringify(receipt)}::jsonb)
      WHERE "envelopeId"=${envelope.id} AND estado='concluida' AND execucao IS NOT NULL`);
  }
};
const finishSeal = async (tx: Prisma.TransactionClient, envelopeId: string, rejected: boolean) => {
  await tx.envelope.update({
    where: { id: envelopeId },
    data: { status: rejected ? 'REJECTED' : 'COMPLETED', completedAt: new Date() },
  });
  await tx.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.outbox(id,"chaveOperacao","envelopeId",kind,payload)
    SELECT ${`${envelopeId}-document-completed`},"chaveOperacao",${envelopeId},'webhook',${JSON.stringify({ event: rejected ? 'DOCUMENT_REJECTED' : 'DOCUMENT_COMPLETED', envelopeId })}::jsonb
    FROM semog_bridge.outbox WHERE "envelopeId"=${envelopeId} AND kind='seal' ON CONFLICT(id) DO NOTHING`);
  return { envelopeId, documentoConcluido: !rejected };
};
const sealLocked = async (
  dependencies: Dependencies,
  signer: Signer,
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelopeId: string,
) => {
  const envelope = await readSemogSealingEnvelope(tx, actor, envelopeId);
  if (envelope.status === 'COMPLETED' || envelope.status === 'REJECTED') {
    return { envelopeId, documentoConcluido: envelope.status === 'COMPLETED' };
  }
  const rejected = assertSealable(dependencies, envelope);
  const readiness = await tx.$queryRaw<{ ready: boolean }[]>(
    Prisma.sql`SELECT semog_bridge.ready_to_seal(${envelopeId}) ready`,
  );
  if (readiness[0]?.ready !== true) {
    throw denied();
  }
  if (!dependencies.getDocumentI18n) {
    throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
  }
  const i18n = await dependencies.getDocumentI18n(envelope.documentMeta.language);
  const event = ZDocumentAuditLogEventDocumentCompletedSchema.parse({
    type: 'DOCUMENT_COMPLETED',
    data: { transactionId: randomUUID() },
  });
  // The real completion audit belongs to this transaction. Rendering/signing failure rolls it back.
  await tx.documentAuditLog.create({ data: { envelopeId, ...event } });
  await persistSealedItems(tx, dependencies, envelope, signer, rejected, i18n);
  return await finishSeal(tx, envelopeId, rejected);
};
export const createSemogPrismaSealer = (dependencies: Dependencies) => ({
  seal: async (actor: SemogActor, envelopeId: string) => {
    if (dependencies.enabled !== true || !dependencies.signer) {
      throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
    }
    const signer = dependencies.signer;
    return await dependencies.client.$transaction((tx) => sealLocked(dependencies, signer, tx, actor, envelopeId), {
      isolationLevel: 'Serializable',
      timeout: 60000,
      maxWait: 10000,
    });
  },
});
