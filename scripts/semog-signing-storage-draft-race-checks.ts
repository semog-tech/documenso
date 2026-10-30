/**
 * A draft that reuses the object of an envelope cancelled long ago, racing the purge, on real PostgreSQL + MinIO:
 * the draft uploads (the object exists, so no PUT and LastModified stays old), the purge removes it on another
 * connection before the draft commits, and the draft's post-commit check must put it back from its bytes.
 * Run by semog-signing-storage-local.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createSemogDraftRuntime } from '../packages/lib/server-only/semog-signing/draft-runtime';
import type { SemogPdfStore } from '../packages/lib/server-only/semog-signing/pdf-store';
import { putSemogStoredPdf, readSemogStoredPdf } from '../packages/lib/server-only/semog-signing/pdf-store';
import type { SemogS3Settings } from '../packages/lib/server-only/semog-signing/pdf-store-s3';
import { createSemogS3PurgeObjects } from '../packages/lib/server-only/semog-signing/pdf-store-s3';
import type { SemogPurgeOutcome } from '../packages/lib/server-only/semog-signing/storage-purge';
import { createSemogPurgeLedger, runSemogStoragePurge } from '../packages/lib/server-only/semog-signing/storage-purge';

type Actor = { teamId: number; userId: number };
export type SemogDraftPurgeRaceDeps = {
  client: PrismaClient;
  actor: Actor;
  settings: SemogS3Settings;
  sql: (statement: string) => Promise<string>;
  createEnvelope: (document: { type: 'S3_PATH'; data: string }) => Promise<{ envelopeId: string }>;
  pdf: (label: string) => Promise<Uint8Array>;
};

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};
const draftBody = (pdf: Uint8Array) => {
  const field = { pagina: 1, x: 10, y: 10, largura: 20, altura: 10, obrigatorio: true };
  return {
    operacaoId: randomUUID(),
    externalId: randomUUID(),
    versao: 1,
    ordemAssinatura: 'paralela',
    titulo: 'Reenvio',
    arquivo: {
      nome: 'reenvio.pdf',
      pdfBase64: Buffer.from(pdf).toString('base64'),
      sha256: createHash('sha256').update(pdf).digest('hex'),
    },
    signatarios: [
      {
        referencia: randomUUID(),
        nome: 'Pessoa',
        email: 'pessoa@example.invalid',
        ordem: 0,
        role: 'SIGNER',
        campos: [{ ...field, referencia: randomUUID(), tipo: 'SIGNATURE', papel: 'assinatura' }],
      },
    ],
  };
};
/** The cancelled envelope that owns the object: bridge draft, cancelled 100 days ago. */
const cancelledOwner = async (deps: SemogDraftPurgeRaceDeps, key: string) => {
  const owner = await deps.createEnvelope({ type: 'S3_PATH', data: key });
  await deps.sql(`INSERT INTO semog_bridge.draft_receipts("operacaoId","externalId","teamId","userId",hash,"envelopeId",resultado)
      VALUES(gen_random_uuid(),gen_random_uuid(),${deps.actor.teamId},${deps.actor.userId},repeat('a',64),'${owner.envelopeId}','{}');
    UPDATE public."Envelope" SET status='CANCELLED', "completedAt"=clock_timestamp()-interval '100 days' WHERE id='${owner.envelopeId}';`);
  return owner.envelopeId;
};

export const checkSemogDraftPurgeRace = async (deps: SemogDraftPurgeRaceDeps) => {
  const objects = createSemogS3PurgeObjects(deps.settings);
  // The native draft numbers documents from this counter; far above the fixtures' document_9xxx ids.
  await deps.sql(`INSERT INTO public."Counter"(id,value) VALUES('document',1000000) ON CONFLICT (id) DO NOTHING`);
  const bytes = await deps.pdf('reenvio-com-os-mesmos-bytes');
  const { data: key } = await putSemogStoredPdf(objects, bytes);
  const cancelled = await cancelledOwner(deps, key);
  let purged: SemogPurgeOutcome[] = [];
  // The purge runs right after the draft's upload is read back and before its transaction: the worst moment.
  const racing: SemogPdfStore = {
    ...objects,
    read: async (candidate) => {
      const read = await objects.read(candidate);
      if (candidate === key && purged.length === 0) {
        purged = await runSemogStoragePurge(
          { ledger: createSemogPurgeLedger(deps.client), objects },
          {
            retentionDays: 90,
            graceHours: 0,
            immediateEnvelopeId: cancelled,
            motivo: 'Corrida com rascunho',
            quem: 'teste-local',
            apply: true,
          },
        );
        assert((await objects.lastModified(key)) === null, 'a purga deveria ter apagado o objeto no meio do rascunho');
      }
      return read;
    },
  };
  const draft = await createSemogDraftRuntime({ enabled: true, client: deps.client, pdfStore: racing }).service.create(
    deps.actor,
    draftBody(bytes),
  );
  assert(
    purged.some((item) => item.chave === key && item.resultado === 'purgada'),
    'a purga não rodou no meio',
  );
  const item = await deps.client.envelopeItem.findFirstOrThrow({
    where: { envelopeId: draft.envelopeId },
    include: { documentData: true },
  });
  assert(item.documentData.data === key, 'o rascunho não referencia a chave reaproveitada');
  const stored = await readSemogStoredPdf(objects, key).catch(() => null);
  assert(
    stored !== null && Buffer.from(stored).equals(Buffer.from(bytes)),
    'rascunho comitado ficou apontando para objeto apagado pela purga',
  );
};
