import type { Signer } from '@libpdf/core';
import type { PrismaClient } from '@prisma/client';
import { createSemogApiTokenAuthenticator } from './api-token';
import { createSemogCancelHandler } from './cancel-http';
import { createSemogCancelService } from './cancel-service';
import { createSemogContactHandler } from './contact-http';
import { createSemogContactService } from './contact-service';
import type { SemogDocumentI18n } from './document-pages';
import { createSemogPrismaExecutor } from './execution';
import type { SemogExternalEffects } from './execution-effects';
import { createSemogExtensionHandler } from './extension-http';
import { createSemogExtensionService } from './extension-service';
import { createSemogSigningHandler } from './http';
import { createSemogPdfReader } from './initial-pdf';
import { readSemogNativeEnvelope } from './native-envelope';
import type { SemogOutboxEffect } from './outbox';
import { createSemogOutboxWorker } from './outbox';
import { createSemogPartialSealHandler } from './partial-seal-http';
import { createSemogPartialSealService } from './partial-seal-service';
import type { SemogPdfStore } from './pdf-store';
import { createSemogSigningPostgresClient, createSemogSigningRepository } from './repository';
import { createSemogPrismaSealer } from './sealing';
import { createSemogSigningService } from './service';
import type { SemogStageObserver } from './timing';

type Dependencies = {
  enabled?: boolean;
  client: PrismaClient;
  signer?: Signer;
  rejectionFont?: Uint8Array;
  /** Native S3/R2 transport; without it the bridge keeps PDFs inline (BYTES_64) as before. */
  pdfStore?: SemogPdfStore;
  deliver?: (effect: SemogOutboxEffect) => Promise<void>;
  sealOnly?: boolean;
  getDocumentI18n?: SemogDocumentI18n;
  /** Per-stage manifestation durations for the host log; never receives personal or document data. */
  observe?: SemogStageObserver;
  /** `suppress` only once the outbox migration accepts the final 'suprimido' state (see the host). */
  externalEffects?: SemogExternalEffects;
};
/** Explicit host composition. Creating this object mounts no route, starts no worker and reads no environment. */
export const createSemogSigningRuntime = (dependencies: Dependencies) => {
  const { client, enabled, observe, externalEffects } = dependencies;
  const { pdfStore } = dependencies;
  const readPdf = createSemogPdfReader(pdfStore);
  const repository = createSemogSigningRepository(
    createSemogSigningPostgresClient({
      query: async (statement, values) => {
        // SQL text is generated exclusively by the fixed repository allowlist; values are always parameterized.
        const rows = await client.$queryRawUnsafe<{ result: unknown }[]>(statement, ...values);
        return { rows };
      },
    }),
  );
  const executor = createSemogPrismaExecutor({ enabled, client, readPdf, observe, externalEffects });
  const service = createSemogSigningService({
    enabled,
    repository,
    executor,
    observe,
    authenticate: createSemogApiTokenAuthenticator(client),
    readCurrent: async ({ envelopeId, actor }) => {
      const current = await readSemogNativeEnvelope(client, envelopeId, actor);
      const data = current.envelope.envelopeItems[0].documentData;
      return {
        envelope: current.source,
        pdf: await readPdf({ documentDataId: data.id, type: data.type, data: data.initialData }),
      };
    },
  });
  const sealer = createSemogPrismaSealer({
    enabled,
    client,
    readPdf,
    pdfStore,
    externalEffects,
    signer: dependencies.signer,
    rejectionFont: dependencies.rejectionFont,
    getDocumentI18n: dependencies.getDocumentI18n,
  });
  // Same signer, font and catalogue as the native seal; the round PDF never replaces the envelope document.
  const partialSeal = createSemogPartialSealService({
    enabled,
    client,
    readPdf,
    pdfStore,
    signer: dependencies.signer,
    stampFont: dependencies.rejectionFont,
    getDocumentI18n: dependencies.getDocumentI18n,
    authenticate: createSemogApiTokenAuthenticator(client),
  });
  const extension = createSemogExtensionService({
    enabled,
    client,
    authenticate: createSemogApiTokenAuthenticator(client),
  });
  const contact = createSemogContactService({
    enabled,
    client,
    readPdf,
    authenticate: createSemogApiTokenAuthenticator(client),
  });
  const cancel = createSemogCancelService({
    enabled,
    client,
    authenticate: createSemogApiTokenAuthenticator(client),
  });
  const outbox = createSemogOutboxWorker({
    enabled,
    client,
    deliver: dependencies.deliver,
    sealOnly: dependencies.sealOnly,
  });
  return {
    handler: createSemogSigningHandler(service),
    partialSealHandler: createSemogPartialSealHandler(partialSeal),
    extensionHandler: createSemogExtensionHandler(extension),
    contactHandler: createSemogContactHandler(contact),
    cancelHandler: createSemogCancelHandler(cancel),
    service,
    repository,
    executor,
    sealer,
    partialSeal,
    extension,
    contact,
    cancel,
    outbox,
  };
};
