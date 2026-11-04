/** Real flow comparison reused by the disposable PostgreSQL runner. */

import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Signer } from '@libpdf/core';
import type { PrismaClient } from '@prisma/client';
import type { SemogDocumentI18n } from '../packages/lib/server-only/semog-signing/document-pages';
import { createSemogPdfDiskCache } from '../packages/lib/server-only/semog-signing/pdf-disk-cache';
import { createSemogS3PdfStore } from '../packages/lib/server-only/semog-signing/pdf-store-s3';
import type { SemogActor } from '../packages/lib/server-only/semog-signing/service';
import { buildLargeRehearsalPdf, verifyLargePdfCms } from './semog-signing-large-pdf';
import { measureSemogMultipart } from './semog-signing-pdf-multipart-local';
import { createSyntheticS3, runPdfStorageFlow } from './semog-signing-pdf-storage-fixture';

export const runPdfStorageScenario = async (context: {
  database: PrismaClient;
  actor: SemogActor;
  root: string;
  workspace: string;
  services: { signer: Signer; font: Uint8Array; getDocumentI18n: SemogDocumentI18n };
  baselineStore: typeof createSemogS3PdfStore;
}) => {
  const { database, actor, root, workspace, services, baselineStore } = context;
  await database.counter.upsert({ where: { id: 'document' }, create: { id: 'document', value: 0 }, update: {} });
  const bytes = Buffer.from(await buildLargeRehearsalPdf(resolve(workspace, 'assets/example.pdf')), 'base64');
  for (const latencyMs of [1000, 2500, 4000]) {
    const fixture = await createSyntheticS3(latencyMs, 'shared', 0);
    try {
      for (const label of ['baseline', 'current'] as const) {
        fixture.reset();
        const cache = createSemogPdfDiskCache({
          enabled: label === 'current',
          directory: join(await realpath(root), `cache-${latencyMs}-${label}`),
          minFreeBytes: 0,
        });
        const measurements: { stage: string; ms: number }[] = [];
        const observe: import('../packages/lib/server-only/semog-signing/timing').SemogStageObserver = (value) => {
          measurements.push(value);
        };
        const store =
          label === 'baseline'
            ? baselineStore(fixture.settings, observe)
            : createSemogS3PdfStore({ ...fixture.settings, cache }, observe);
        try {
          const measure = async <T>(stage: string, run: () => Promise<T>) => {
            const before = fixture.counts();
            const started = performance.now();
            const result = await run();
            const after = fixture.counts();
            console.log(
              JSON.stringify({
                rehearsal: 'pdf-storage-integrated',
                baseline: '4d3fc306',
                label,
                latencyMs,
                bytes: bytes.byteLength,
                stage,
                ms: Math.round((performance.now() - started) * 100) / 100,
                requests: Object.fromEntries(
                  Object.entries(after).map(([key, value]) => [key, value - before[key as keyof typeof before]]),
                ),
              }),
            );
            return result;
          };
          const sealed = await runPdfStorageFlow({
            client: database,
            actor,
            signer: services.signer,
            font: services.font,
            getDocumentI18n: services.getDocumentI18n,
            bytes,
            store,
            observe,
            measure,
          });
          await verifyLargePdfCms(sealed, root);
          if (label === 'current' && fixture.counts().get !== 0) {
            throw new Error('Warm cache flow unexpectedly downloaded R2 bytes');
          }
          console.log(
            JSON.stringify({
              rehearsal: 'pdf-storage-integrated-summary',
              label,
              latencyMs,
              cmsVerified: true,
              requests: fixture.counts(),
              measurements,
            }),
          );
        } finally {
          cache.close();
        }
      }
      await measureSemogMultipart(bytes, latencyMs);
    } finally {
      await fixture.close();
    }
  }
};
