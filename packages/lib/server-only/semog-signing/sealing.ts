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
import type { SemogExternalEffects } from './execution-effects';
import { resolveSemogExternalEffects, semogEffectState } from './execution-effects';
import { readSemogOutside } from './execution-observed';
import type { SemogPdfReader } from './initial-pdf';
import type { SemogPdfStore } from './pdf-store';
import { persistSemogDerivedPdf, recordSemogWrites } from './pdf-store';
import type { SemogSealNotification } from './seal-notify';
import type { SemogActor } from './service';
import type { SemogStageObserver } from './timing';
import { timeSemogStage } from './timing';

type Dependencies = {
  enabled?: boolean;
  observe?: SemogStageObserver;
  client: SemogPrismaTransactionRunner;
  readPdf: SemogPdfReader;
  pdfStore?: SemogPdfStore;
  externalEffects?: SemogExternalEffects;
  signer?: Signer;
  rejectionFont?: Uint8Array;
  getDocumentI18n?: SemogDocumentI18n;
  notifyCompleted?: (notification: SemogSealNotification) => void;
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
  observe?: SemogStageObserver;
  signer: Signer;
  rejectionFont: Uint8Array | null;
  documentPages: Uint8Array[];
  /** Runs after the appendix and fields, so it reaches every page of the sealed PDF. */
  stampAllPages?: (pdf: PDF) => void;
  /** Signature /Reason; the native seal keeps the stock value. */
  reason?: string;
};
/** The library's Signer port signs CMS attributes; PDF serialization/hash/CMS assembly stay in seal.sign. */
const observeSigner = (signer: Signer, observe: SemogStageObserver | undefined): Signer => ({
  get certificate() {
    return signer.certificate;
  },
  get certificateChain() {
    return signer.certificateChain;
  },
  get keyType() {
    return signer.keyType;
  },
  get signatureAlgorithm() {
    return signer.signatureAlgorithm;
  },
  sign: (data, algorithm) => timeSemogStage(observe, 'seal.signer', () => signer.sign(data, algorithm)),
});
export const decorateSemogPdf = async (bytes: Uint8Array, options: DecorateOptions) => {
  const observe = options.observe;
  const pdf = await timeSemogStage(observe, 'seal.pdf-load', () => PDF.load(bytes));
  await timeSemogStage(observe, 'seal.decorate', async () => {
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
  });
  const saved = await timeSemogStage(observe, 'seal.pdf-save', () => pdf.save({ useXRefStream: true }));
  const normalized = await timeSemogStage(observe, 'seal.normalize', () => PDF.load(saved));
  return await timeSemogStage(
    observe,
    'seal.sign',
    async () =>
      (
        await normalized.sign({
          signer: observe ? observeSigner(options.signer, observe) : options.signer,
          reason: options.reason ?? 'Signed by Documenso',
          subFilter: 'ETSI.CAdES.detached',
        })
      ).bytes,
  );
};

export const readSemogSealingEnvelope = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelopeId: string,
  observe?: SemogStageObserver,
) => {
  const lock = await timeSemogStage(observe, 'seal.lock', () =>
    tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM public."Envelope" WHERE id=${envelopeId} AND "teamId"=${actor.teamId} FOR UPDATE`,
    ),
  );
  if (lock.length !== 1) {
    throw new AppError(AppErrorCode.NOT_FOUND, { statusCode: 404 });
  }
  return await timeSemogStage(observe, 'seal.envelope', () =>
    tx.envelope.findUniqueOrThrow({
      where: { id: envelopeId },
      include: {
        recipients: true,
        documentMeta: true,
        user: { select: { name: true, email: true } },
        fields: { include: { signature: true } },
        envelopeItems: { include: { documentData: true } },
      },
    }),
  );
};
export type SemogSealingEnvelope = Awaited<ReturnType<typeof readSemogSealingEnvelope>>;
/** Original PDFs read before a seal transaction, keyed by DocumentData id, with the INITIAL_DATA they came from. */
export type SemogPrereadOriginals = Map<string, { initialData: string; bytes: Uint8Array }>;
/** No lock and no object read inside the seal transaction: the originals come from here, read just before it. */
export const prereadSemogOriginals = async (
  client: SemogPrismaTransactionRunner,
  readPdf: SemogPdfReader,
  actor: SemogActor,
  envelopeId: string,
  observe?: SemogStageObserver,
): Promise<SemogPrereadOriginals> => {
  const items = await timeSemogStage(observe, 'seal.source', () =>
    readSemogOutside(client, (tx) =>
      tx.envelopeItem.findMany({
        where: { envelopeId, envelope: { teamId: actor.teamId, status: 'PENDING' } },
        select: { documentData: { select: { id: true, type: true, initialData: true } } },
      }),
    ),
  );
  const originals: SemogPrereadOriginals = new Map();
  for (const { documentData } of items) {
    const bytes = await timeSemogStage(observe, 'seal.read', () =>
      readPdf({
        documentDataId: documentData.id,
        type: documentData.type,
        data: documentData.initialData,
      }),
    );
    originals.set(documentData.id, { initialData: documentData.initialData, bytes });
  }
  return originals;
};
/** The locked row must still name the very INITIAL_DATA read before; otherwise the effect is retried later. */
export const takeSemogOriginal = (
  originals: SemogPrereadOriginals,
  documentData: { id: string; initialData: string },
) => {
  const original = originals.get(documentData.id);
  if (!original || original.initialData !== documentData.initialData) {
    throw denied();
  }
  return original.bytes;
};
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
  originals: SemogPrereadOriginals,
) => {
  const pdf = takeSemogOriginal(originals, item.documentData);
  const original = await timeSemogStage(dependencies.observe, 'seal.original-load', () => PDF.load(pdf));
  const lastPage = original.getPage(original.getPageCount() - 1);
  if (!lastPage) {
    throw denied();
  }
  const documentPages = await timeSemogStage(dependencies.observe, 'seal.render', () =>
    renderSemogDocumentPages(
      tx,
      { ...envelope, status: rejected ? 'REJECTED' : 'COMPLETED' },
      { width: lastPage.width, height: lastPage.height },
      i18n,
    ),
  );
  return await decorateSemogPdf(pdf, {
    observe: dependencies.observe,
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
  originals: SemogPrereadOriginals,
) => {
  for (const item of envelope.envelopeItems) {
    const signed = await createItemPdf(tx, dependencies, envelope, signer, rejected, i18n, item, originals);
    // An object-stored original gets an object-stored seal (written here, before commit, under its content
    // address); the original stays referenced by its own key, never copied. Inline originals keep inline seals.
    const stored = await timeSemogStage(dependencies.observe, 'seal.storage', () =>
      persistSemogDerivedPdf(dependencies.pdfStore, item.documentData.type, signed),
    );
    const data = await timeSemogStage(dependencies.observe, 'seal.document-write', async () => {
      const data = await tx.documentData.create({
        data: { type: stored.type, data: stored.data, initialData: item.documentData.initialData },
      });
      await tx.envelopeItem.update({ where: { id: item.id }, data: { documentDataId: data.id } });
      return data;
    });
    await timeSemogStage(dependencies.observe, 'seal.receipt-write', async () => {
      const receipt = {
        documentDataId: data.id,
        hashPdf: createHash('sha256').update(signed).digest('hex'),
        metadata: {
          type: stored.type,
          hashInitialDataValue: createHash('sha256').update(item.documentData.initialData).digest('hex'),
          hashDataValue: createHash('sha256').update(stored.data).digest('hex'),
          hashOriginal: createHash('sha256').update(takeSemogOriginal(originals, item.documentData)).digest('hex'),
          bytes: signed.byteLength,
        },
      };
      await tx.$executeRaw(Prisma.sql`UPDATE semog_bridge.operations SET execucao=jsonb_set(execucao,'{selagem}',${JSON.stringify(receipt)}::jsonb)
      WHERE "envelopeId"=${envelope.id} AND estado='concluida' AND execucao IS NOT NULL`);
    });
  }
};
const finishSeal = async (
  tx: Prisma.TransactionClient,
  envelopeId: string,
  rejected: boolean,
  externalEffects: SemogExternalEffects | undefined,
) => {
  const completedAt = new Date();
  await tx.envelope.update({
    where: { id: envelopeId },
    data: { status: rejected ? 'REJECTED' : 'COMPLETED', completedAt },
  });
  const external = await resolveSemogExternalEffects(tx, externalEffects);
  await tx.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.outbox(id,"chaveOperacao","envelopeId",kind,payload,estado)
    SELECT ${`${envelopeId}-document-completed`},"chaveOperacao",${envelopeId},'webhook',${JSON.stringify({ event: rejected ? 'DOCUMENT_REJECTED' : 'DOCUMENT_COMPLETED', envelopeId })}::jsonb,${semogEffectState('webhook', external)}
    FROM semog_bridge.outbox WHERE "envelopeId"=${envelopeId} AND kind='seal' ON CONFLICT(id) DO NOTHING`);
  return { envelopeId, documentoConcluido: !rejected, completedAt };
};
const sealLocked = async (
  dependencies: Dependencies,
  signer: Signer,
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelopeId: string,
  originals: SemogPrereadOriginals,
) => {
  const envelope = await readSemogSealingEnvelope(tx, actor, envelopeId, dependencies.observe);
  if (envelope.status === 'COMPLETED' || envelope.status === 'REJECTED') {
    return { envelopeId, documentoConcluido: envelope.status === 'COMPLETED', completedAt: envelope.completedAt };
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
  await timeSemogStage(dependencies.observe, 'seal.audit', () =>
    tx.documentAuditLog.create({ data: { envelopeId, ...event } }),
  );
  await persistSealedItems(tx, dependencies, envelope, signer, rejected, i18n, originals);
  return await timeSemogStage(dependencies.observe, 'seal.complete', () =>
    finishSeal(tx, envelopeId, rejected, dependencies.externalEffects),
  );
};
export const createSemogPrismaSealer = (dependencies: Dependencies) => ({
  seal: (actor: SemogActor, envelopeId: string) =>
    timeSemogStage(dependencies.observe, 'seal.total', async () => {
      if (dependencies.enabled !== true || !dependencies.signer) {
        throw new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
      }
      const signer = dependencies.signer;
      const originals = await timeSemogStage(dependencies.observe, 'seal.preread', () =>
        prereadSemogOriginals(dependencies.client, dependencies.readPdf, actor, envelopeId, dependencies.observe),
      );
      const writes = recordSemogWrites(dependencies.pdfStore);
      const result = await timeSemogStage(dependencies.observe, 'seal.transaction', () =>
        dependencies.client.$transaction(
          (tx) => sealLocked({ ...dependencies, pdfStore: writes.store }, signer, tx, actor, envelopeId, originals),
          {
            isolationLevel: 'Serializable',
            timeout: 60000,
            maxWait: 10000,
          },
        ),
      );
      // After the commit, outside any transaction: the sealed objects are read back and proven by content.
      await timeSemogStage(dependencies.observe, 'seal.confirm', () => writes.confirm());
      if (result.documentoConcluido && result.completedAt && dependencies.notifyCompleted) {
        try {
          dependencies.notifyCompleted({ envelopeId, completedAt: result.completedAt.toISOString() });
        } catch {
          // This optional hint cannot fail the seal, its confirmation or the outbox acknowledgment.
        }
      }
      return { envelopeId: result.envelopeId, documentoConcluido: result.documentoConcluido };
    }),
});
