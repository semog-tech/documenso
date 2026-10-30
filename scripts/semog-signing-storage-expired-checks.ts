/**
 * End to end, on real PostgreSQL + MinIO: a PENDING envelope whose enrollment EXPIRED (the state the 8 production
 * envelopes reach after their deadline) is migrated inline -> R2, then closed with a partial seal, reopened by the
 * extension, enrolled again, signed and sealed. Proves the new snapshot binds the CURRENT initialData (the key) and
 * that both seals read the original from R2 through the hash-checked reader. Run by semog-signing-storage-local.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { SemogPdfStore } from '../packages/lib/server-only/semog-signing/pdf-store';
import type { createSemogSigningRuntime } from '../packages/lib/server-only/semog-signing/runtime';
import {
  migrateSemogStorageRow,
  planSemogStorageMigration,
} from '../packages/lib/server-only/semog-signing/storage-migration';

type Runtime = ReturnType<typeof createSemogSigningRuntime>;
type Actor = { teamId: number; userId: number };
export type SemogExpiredPendingDeps = {
  client: PrismaClient;
  actor: Actor;
  store: SemogPdfStore;
  sql: (statement: string) => Promise<string>;
  runtimeFor: (store: SemogPdfStore) => Runtime;
  /** Runs a renderer of the native certificate pages, which reads its assets relative to apps/remix. */
  inAppDirectory: <T>(render: () => Promise<T>) => Promise<T>;
  pdf: (label: string) => Promise<Uint8Array>;
};

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Two signers with a deadline, managed by the bridge (draft + activation receipts, as the portal leaves them). */
const createTwoSigners = async (deps: SemogExpiredPendingDeps, bytes: Uint8Array, deadline: Date) => {
  const envelopeId = randomUUID();
  const itemId = randomUUID();
  const data = Buffer.from(bytes).toString('base64');
  const envelope = await deps.client.envelope.create({
    data: {
      id: envelopeId,
      secondaryId: `document_${Math.floor(Math.random() * 1e9)}`,
      title: 'Vencido',
      type: 'DOCUMENT',
      source: 'DOCUMENT',
      status: 'PENDING',
      signatureLevel: 'SES',
      internalVersion: 2,
      user: { connect: { id: deps.actor.userId } },
      team: { connect: { id: deps.actor.teamId } },
      documentMeta: {
        create: {
          language: 'pt-BR',
          distributionMethod: 'NONE',
          drawSignatureEnabled: false,
          uploadSignatureEnabled: false,
        },
      },
      envelopeItems: {
        create: {
          id: itemId,
          title: 'PDF',
          order: 0,
          documentData: { create: { type: 'BYTES_64', data, initialData: data } },
        },
      },
      recipients: {
        create: ['Primeiro', 'Segundo'].map((name, index) => ({
          name,
          email: `signer-${index}-${randomUUID()}@example.invalid`,
          token: randomUUID(),
          expiresAt: deadline,
        })),
      },
    },
    include: { recipients: { orderBy: { id: 'asc' } } },
  });
  const signers = [];
  for (const [index, recipient] of envelope.recipients.entries()) {
    const field = await deps.client.field.create({
      data: {
        envelopeId,
        envelopeItemId: itemId,
        recipientId: recipient.id,
        type: 'SIGNATURE',
        page: 1,
        positionX: 10,
        positionY: 10 + index * 20,
        width: 30,
        height: 10,
        customText: '',
        inserted: false,
        fieldMeta: { type: 'signature', overflow: 'auto' },
      },
    });
    signers.push({ recipient, field });
  }
  await deps.sql(`WITH d AS (INSERT INTO semog_bridge.draft_receipts("operacaoId","externalId","teamId","userId",hash,"envelopeId",resultado)
      VALUES(gen_random_uuid(),gen_random_uuid(),${deps.actor.teamId},${deps.actor.userId},repeat('a',64),'${envelopeId}','{}')
      RETURNING "operacaoId")
    INSERT INTO semog_bridge.activation_receipts("operacaoId","rascunhoOperacaoId","envelopeId","teamId","userId",hash,resultado)
      SELECT gen_random_uuid(),"operacaoId",'${envelopeId}',${deps.actor.teamId},${deps.actor.userId},repeat('a',64),'{}' FROM d`);
  return { envelopeId, itemId, signers };
};
type Signers = Awaited<ReturnType<typeof createTwoSigners>>;

const enroll = (runtime: Runtime, actor: Actor, envelopeId: string, recipientId: number, expiraEm: string) =>
  runtime.service.enroll(actor, { envelopeId, recipientId, consentimento: 'Li e concordo.', expiraEm });
const sign = async (runtime: Runtime, actor: Actor, envelope: Signers, index: number, expiraEm: string) => {
  const { recipient, field } = envelope.signers[index];
  const snapshot = await enroll(runtime, actor, envelope.envelopeId, recipient.id, expiraEm);
  const chaveOperacao = randomUUID();
  const result = await runtime.service.reserve(actor, {
    chaveOperacao,
    envelopeId: envelope.envelopeId,
    recipientId: recipient.id,
    hashDocumento: snapshot.hashDocumento,
    hashConsentimento: snapshot.hashConsentimento,
    acao: 'assinar',
    motivo: null,
    campos: [{ fieldId: field.id, valor: recipient.name }],
    evidencias: {
      canal: 'email',
      identificacaoId: 'local',
      confirmadoEm: new Date().toISOString(),
      ip: null,
      userAgent: null,
    },
  });
  assert(result.situacao === 'concluida', `assinatura ${index + 1} não concluída`);
  return chaveOperacao;
};
/** Counts reads per key: proves the seals took the original from the bucket (the reader checks its hash). */
const countingStore = (store: SemogPdfStore) => {
  const reads = new Map<string, number>();
  const counted: SemogPdfStore = {
    read: (key) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return store.read(key);
    },
    write: store.write,
  };
  return { counted, reads };
};

const migrateAfterExpiry = async (deps: SemogExpiredPendingDeps, envelope: Signers, deadline: string) => {
  const before = (await planSemogStorageMigration(deps.client)).find((row) => row.envelopeId === envelope.envelopeId);
  assert(
    before?.eligible === false && before.elegivelEm?.toISOString() === deadline,
    `antes do prazo deveria estar bloqueado até ${deadline}: ${before?.motivo ?? 'ausente'}`,
  );
  await sleep(Math.max(0, Date.parse(deadline) - Date.now()) + 1000);
  const after = (await planSemogStorageMigration(deps.client)).find((row) => row.envelopeId === envelope.envelopeId);
  if (after?.eligible !== true) {
    throw new Error(`inscrição vencida não deveria bloquear: ${after?.motivo ?? 'ausente'}`);
  }
  await migrateSemogStorageRow(deps.client, deps.store, after);
  return after.dataKey;
};

export const checkSemogExpiredPendingMigration = async (deps: SemogExpiredPendingDeps) => {
  const bytes = await deps.pdf('pendente-vencido');
  const deadline = new Date(Date.now() + 25_000).toISOString();
  const envelope = await createTwoSigners(deps, bytes, new Date(deadline));
  const { counted, reads } = countingStore(deps.store);
  const runtime = deps.runtimeFor(counted);
  await sign(runtime, deps.actor, envelope, 0, deadline);
  await enroll(runtime, deps.actor, envelope.envelopeId, envelope.signers[1].recipient.id, deadline);
  const key = await migrateAfterExpiry(deps, envelope, deadline);
  assert(key === `semog/pdf/${sha256(bytes)}.pdf`, 'chave não é o hash dos bytes');

  reads.clear();
  const round = await deps.inAppDirectory(() =>
    runtime.partialSeal.create(deps.actor, envelope.envelopeId, { rodada: 1, chaveOperacao: randomUUID() }),
  );
  assert(round.assinados === 1 && round.total === 2, `selo parcial: ${round.assinados} de ${round.total}`);
  assert((reads.get(key) ?? 0) > 0, 'selo parcial não leu o original do R2');
  assert((await runtime.partialSeal.pdf(deps.actor, envelope.envelopeId, 1)).byteLength > 0, 'PDF do selo parcial');

  const nextDeadline = new Date(Date.now() + 86_400_000).toISOString();
  const recipientId = envelope.signers[1].recipient.id;
  const extended = await runtime.extension.create(deps.actor, envelope.envelopeId, {
    chaveOperacao: randomUUID(),
    recipientIds: [recipientId],
    expiraEm: nextDeadline,
  });
  assert(extended.snapshotsRevogados === 1, 'a prorrogação deveria revogar a inscrição vencida');
  const signed = await sign(runtime, deps.actor, envelope, 1, nextDeadline);
  const bound =
    await deps.sql(`SELECT s.conteudo->'item'->>'hashInitialData'=encode(sha256(convert_to(d."initialData",'UTF8')),'hex')
    FROM semog_bridge.snapshots s JOIN public."DocumentData" d ON d.id=s.conteudo->'item'->>'documentDataId'
    WHERE s."envelopeId"='${envelope.envelopeId}' AND s."recipientId"=${recipientId} AND s."criadaEm">now()-interval '1 hour'
    ORDER BY s."criadaEm" DESC LIMIT 1`);
  assert(bound === 't', 'nova inscrição não está amarrada ao initialData atual (a chave)');

  reads.clear();
  await deps.inAppDirectory(() => runtime.sealer.seal(deps.actor, envelope.envelopeId));
  const sealed = await deps.client.envelope.findUniqueOrThrow({
    where: { id: envelope.envelopeId },
    include: { envelopeItems: { include: { documentData: true } } },
  });
  const data = sealed.envelopeItems[0].documentData;
  assert(sealed.status === 'COMPLETED', `envelope não concluiu: ${sealed.status}`);
  assert(data.type === 'S3_PATH' && data.initialData === key, 'selado não referencia o original migrado');
  assert((reads.get(key) ?? 0) > 0, 'selo final não leu o original do R2');
  assert((await runtime.executor.get(deps.actor, signed)).pdfDisponivel, 'PDF final indisponível');
};
