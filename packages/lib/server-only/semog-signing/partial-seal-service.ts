import { createHash } from 'node:crypto';
import type { Signer } from '@libpdf/core';
import { PDF } from '@libpdf/core';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppErrorCode } from '../../errors/app-error';
import type { SemogDocumentI18n, SemogPartialSealCount } from './document-pages';
import { renderSemogDocumentPages } from './document-pages';
import type { SemogPrismaTransactionRunner } from './execution';
import { isSemogRetryableTransactionError } from './execution';
import type { SemogPdfReader } from './initial-pdf';
import type { SemogPartialSealRequest, SemogPartialSealSigner } from './partial-seal-contract';
import { semogPartialSealLabel, ZSemogPartialSealRequest } from './partial-seal-contract';
import {
  assertSemogPartialSealManaged,
  partialSealConflict,
  readSemogPartialSealDocument,
  readSemogPartialSealReplay,
  saveSemogPartialSeal,
} from './partial-seal-repository';
import type { SemogPdfStore } from './pdf-store';
import { persistSemogDerivedPdf, recordSemogWrites } from './pdf-store';
import { isSemogUniqueViolation, semogRefusal } from './route-refusal';
import type { SemogPrereadOriginals, SemogSealingEnvelope } from './sealing';
import {
  decorateSemogPdf,
  prereadSemogOriginals,
  readSemogSealingEnvelope,
  stampSemogPartialSeal,
  takeSemogOriginal,
} from './sealing';
import type { SemogActor } from './service';
import { semogError } from './service-validation';

type Dependencies = {
  enabled?: boolean;
  client: SemogPrismaTransactionRunner;
  readPdf: SemogPdfReader;
  pdfStore?: SemogPdfStore;
  signer?: Signer;
  stampFont?: Uint8Array;
  getDocumentI18n?: SemogDocumentI18n;
  authenticate: (token: string) => Promise<SemogActor | null>;
  now?: () => Date;
};
type Setup = Required<Pick<Dependencies, 'signer' | 'stampFont' | 'getDocumentI18n'>> & Dependencies;
const ZEnvelopeId = z.string().min(1).max(255);

/** Every non-CC recipient counts toward N; each signature stands alone (no quorum). */
const listSigners = (envelope: SemogSealingEnvelope): SemogPartialSealSigner[] =>
  envelope.recipients
    .filter((recipient) => recipient.role !== 'CC')
    .sort((a, b) => a.id - b.id)
    .map((recipient) => ({
      recipientId: recipient.id,
      nome: recipient.name,
      email: recipient.email,
      assinou: recipient.signingStatus === 'SIGNED',
      assinadoEm: recipient.signingStatus === 'SIGNED' ? (recipient.signedAt?.toISOString() ?? null) : null,
    }));

/** Same gates as the native seal, except that missing signatures are the point; everyone signed belongs to it. */
const assertPartiallySealable = (envelope: SemogSealingEnvelope) => {
  const signers = listSigners(envelope);
  const signed = signers.filter((signer) => signer.assinou).length;
  if (
    envelope.status !== 'PENDING' ||
    envelope.internalVersion !== 2 ||
    envelope.signatureLevel !== 'SES' ||
    envelope.useLegacyFieldInsertion ||
    envelope.envelopeItems.length !== 1 ||
    envelope.recipients.some((recipient) => recipient.signingStatus === 'REJECTED') ||
    signers.length === 0 ||
    signed === signers.length
  ) {
    throw partialSealConflict();
  }
  return { signers, signed, item: envelope.envelopeItems[0] };
};

const renderPartialPdf = async (
  tx: Prisma.TransactionClient,
  dependencies: Setup,
  envelope: SemogSealingEnvelope,
  count: SemogPartialSealCount,
  label: string,
  originals: SemogPrereadOriginals,
) => {
  const item = envelope.envelopeItems[0];
  const pdf = takeSemogOriginal(originals, item.documentData);
  const original = await PDF.load(pdf);
  const lastPage = original.getPage(original.getPageCount() - 1);
  if (!lastPage) {
    throw partialSealConflict();
  }
  const i18n = await dependencies.getDocumentI18n(envelope.documentMeta.language);
  // No QR: the share link would show the in-progress document, not this partial seal.
  const documentPages = await renderSemogDocumentPages(
    tx,
    { ...envelope, qrToken: null },
    { width: lastPage.width, height: lastPage.height },
    i18n,
    count,
  );
  return await decorateSemogPdf(pdf, {
    fields: envelope.fields.filter((field) => field.envelopeItemId === item.id),
    signer: dependencies.signer,
    rejectionFont: null,
    documentPages,
    stampAllPages: (document) => stampSemogPartialSeal(document, dependencies.stampFont, label),
    reason: `Selo parcial ${count.assinados} de ${count.total}`,
  });
};

const sealPartialLocked = async (
  tx: Prisma.TransactionClient,
  dependencies: Setup,
  actor: SemogActor,
  envelopeId: string,
  input: SemogPartialSealRequest,
  originals: SemogPrereadOriginals,
) => {
  const envelope = await readSemogSealingEnvelope(tx, actor, envelopeId);
  await assertSemogPartialSealManaged(tx, actor, envelopeId);
  const replay = await readSemogPartialSealReplay(tx, actor, envelopeId, input);
  if (replay) {
    return replay;
  }
  const { signers, signed, item } = assertPartiallySealable(envelope);
  const label = semogPartialSealLabel(signed, signers.length, (dependencies.now ?? (() => new Date()))());
  const sealed = await renderPartialPdf(
    tx,
    dependencies,
    envelope,
    { assinados: signed, total: signers.length },
    label,
    originals,
  );
  // A new DocumentData only: the envelope item keeps pointing at its own document. Same storage as the original.
  const document = await persistSemogDerivedPdf(dependencies.pdfStore, item.documentData.type, sealed);
  const data = await tx.documentData.create({
    data: { type: document.type, data: document.data, initialData: item.documentData.initialData },
  });
  const hashPdf = createHash('sha256').update(sealed).digest('hex');
  await saveSemogPartialSeal(tx, actor, envelopeId, input, { documentDataId: data.id, hashPdf, assinantes: signers });
  const stored = await readSemogPartialSealReplay(tx, actor, envelopeId, input);
  if (!stored) {
    throw partialSealConflict();
  }
  return stored;
};

const requireSetup = (dependencies: Dependencies): Setup => {
  const { signer, stampFont, getDocumentI18n } = dependencies;
  if (!signer || !stampFont || !getDocumentI18n) {
    throw semogError(AppErrorCode.NOT_SETUP, 503);
  }
  return { ...dependencies, signer, stampFont, getDocumentI18n };
};

/** Seals what was signed so far without completing, rejecting or re-pointing the PENDING envelope. */
export const createSemogPartialSealService = (dependencies: Dependencies) => {
  const requireEnabled = () => {
    if (dependencies.enabled !== true) {
      throw semogError(AppErrorCode.NOT_SETUP, 503);
    }
  };
  return {
    authenticate: async (token: string) => {
      requireEnabled();
      const actor = await dependencies.authenticate(token);
      if (!actor) {
        throw semogError(AppErrorCode.UNAUTHORIZED, 401);
      }
      return actor;
    },
    create: async (actor: SemogActor, envelopeId: string, body: unknown) => {
      requireEnabled();
      const input = ZSemogPartialSealRequest.parse(body);
      const id = ZEnvelopeId.parse(envelopeId);
      const setup = requireSetup(dependencies);
      const originals = await prereadSemogOriginals(dependencies.client, dependencies.readPdf, actor, id);
      for (let attempt = 0; ; attempt++) {
        const writes = recordSemogWrites(setup.pdfStore);
        try {
          const sealed = await dependencies.client.$transaction(
            (tx) => sealPartialLocked(tx, { ...setup, pdfStore: writes.store }, actor, id, input, originals),
            {
              // Read Committed on purpose: a Serializable snapshot starts at the first statement, before the
              // envelope lock wait, and would miss a signature committed while this seal was queued behind it.
              // Every bridge and native mutation of the envelope takes the same row lock (the executor and the
              // guard trigger), so after the lock each statement sees a stable, current envelope. A concurrent
              // first call for the same round waits on the lock and then reads the committed row as a replay.
              isolationLevel: 'ReadCommitted',
              timeout: 60000,
              maxWait: 10000,
            },
          );
          // After the commit: the round's sealed object is read back and proven by content.
          await writes.confirm();
          return sealed;
        } catch (error) {
          if (isSemogUniqueViolation(error)) {
            // Same key committed meanwhile by a seal of another envelope: the same answer as a reused key.
            throw semogRefusal({ codigo: 'chave-reutilizada' });
          }
          // Deadlocks (40P01) are retried; the losing attempt wrote nothing.
          if (attempt === 2 || !isSemogRetryableTransactionError(error)) {
            throw error;
          }
        }
      }
    },
    pdf: async (actor: SemogActor, envelopeId: string, rodada: number) => {
      requireEnabled();
      const round = ZSemogPartialSealRequest.shape.rodada.parse(rodada);
      const id = ZEnvelopeId.parse(envelopeId);
      const { seal, data } = await dependencies.client.$transaction(
        async (tx) => {
          const seal = await readSemogPartialSealDocument(tx, actor, id, round);
          const data = await tx.documentData.findUniqueOrThrow({
            where: { id: seal.documentDataId },
            select: { id: true, type: true, data: true },
          });
          return { seal, data };
        },
        { isolationLevel: 'Serializable', timeout: 30000 },
      );
      // Read after the transaction: the recorded SHA-256 of the round's PDF is what proves these bytes.
      const bytes = await dependencies.readPdf({ documentDataId: data.id, type: data.type, data: data.data });
      if (createHash('sha256').update(bytes).digest('hex') !== seal.hashPdf) {
        throw partialSealConflict();
      }
      return bytes;
    },
  };
};
export type SemogPartialSealService = ReturnType<typeof createSemogPartialSealService>;
