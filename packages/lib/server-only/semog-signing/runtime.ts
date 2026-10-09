import type { Signer } from '@libpdf/core';
import type { PrismaClient } from '@prisma/client';
import { createSemogApiTokenAuthenticator } from './api-token';
import type { SemogDocumentI18n } from './document-pages';
import { createSemogPrismaExecutor } from './execution';
import { createSemogSigningHandler } from './http';
import { createSemogPdfReader } from './initial-pdf';
import { readSemogNativeEnvelope } from './native-envelope';
import type { SemogOutboxEffect } from './outbox';
import { createSemogOutboxWorker } from './outbox';
import { createSemogSigningPostgresClient, createSemogSigningRepository } from './repository';
import { createSemogPrismaSealer } from './sealing';
import { createSemogSigningService } from './service';

type Dependencies = {
  enabled?: boolean;
  client: PrismaClient;
  signer?: Signer;
  rejectionFont?: Uint8Array;
  readS3?: (key: string) => Promise<Uint8Array>;
  deliver?: (effect: SemogOutboxEffect) => Promise<void>;
  sealOnly?: boolean;
  getDocumentI18n?: SemogDocumentI18n;
};
/** Explicit host composition. Creating this object mounts no route, starts no worker and reads no environment. */
export const createSemogSigningRuntime = (dependencies: Dependencies) => {
  const { client, enabled } = dependencies;
  const readPdf = createSemogPdfReader(dependencies.readS3);
  const repository = createSemogSigningRepository(
    createSemogSigningPostgresClient({
      query: async (statement, values) => {
        // SQL text is generated exclusively by the fixed repository allowlist; values are always parameterized.
        const rows = await client.$queryRawUnsafe<{ result: unknown }[]>(statement, ...values);
        return { rows };
      },
    }),
  );
  const executor = createSemogPrismaExecutor({ enabled, client, readPdf });
  const service = createSemogSigningService({
    enabled,
    repository,
    executor,
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
    signer: dependencies.signer,
    rejectionFont: dependencies.rejectionFont,
    getDocumentI18n: dependencies.getDocumentI18n,
  });
  const outbox = createSemogOutboxWorker({
    enabled,
    client,
    deliver: dependencies.deliver,
    sealOnly: dependencies.sealOnly,
  });
  return { handler: createSemogSigningHandler(service), service, repository, executor, sealer, outbox };
};
