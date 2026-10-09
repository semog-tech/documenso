import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { SEMOG_ACTIVATION_PATH } from '../packages/lib/server-only/semog-signing/activation-http';
import {
  isSemogActivationManaged,
  listSemogActivationManaged,
} from '../packages/lib/server-only/semog-signing/activation-ownership';
import { createSemogActivationRuntime } from '../packages/lib/server-only/semog-signing/activation-runtime';
import type { SemogDraftRequest } from '../packages/lib/server-only/semog-signing/draft-contract';
import { createSemogDraftRuntime } from '../packages/lib/server-only/semog-signing/draft-runtime';
import type { SemogActor } from '../packages/lib/server-only/semog-signing/service';

type Dependencies = {
  client: PrismaClient;
  actor: SemogActor;
  draftInput(): Promise<SemogDraftRequest>;
  sql(input: string): Promise<string>;
};
const freshCase = async ({ client, actor, draftInput }: Dependencies) => {
  const payload = await draftInput();
  const draft = await createSemogDraftRuntime({ enabled: true, client }).service.create(actor, payload);
  return {
    draft,
    input: {
      operacaoId: randomUUID(),
      rascunhoOperacaoId: draft.operacaoId,
      envelopeId: draft.envelopeId,
      externalId: payload.externalId,
      hashPdf: payload.arquivo.sha256,
      expiraEm: new Date(Date.now() + 86400000).toISOString(),
    },
  };
};
const checkReplay = async (deps: Dependencies) => {
  const { client, actor } = deps;
  const runtime = createSemogActivationRuntime({ enabled: true, client });
  const { input, draft } = await freshCase(deps);
  const [first, second] = await Promise.all([
    runtime.service.activate(actor, input),
    runtime.service.activate(actor, input),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'PENDING');
  const envelope = await client.envelope.findUniqueOrThrow({
    where: { id: draft.envelopeId },
    include: { recipients: true, documentMeta: true },
  });
  assert.equal(envelope.status, 'PENDING');
  assert.equal(envelope.documentMeta.distributionMethod, 'NONE');
  assert(
    envelope.recipients.every(
      (r) => r.sendStatus === 'NOT_SENT' && r.sentAt === null && r.expiresAt?.toISOString() === input.expiraEm,
    ),
  );
  assert(await isSemogActivationManaged(client, draft.envelopeId));
  assert((await listSemogActivationManaged(client)).includes(draft.envelopeId));
  const expiredClock = createSemogActivationRuntime({
    enabled: true,
    client,
    now: () => new Date(Date.now() + 172800000),
  });
  await assert.rejects(expiredClock.service.activate(actor, input), { statusCode: 409 });
  await assert.rejects(
    runtime.service.activate(actor, { ...input, expiraEm: new Date(Date.now() + 172800000).toISOString() }),
    { statusCode: 409 },
  );
  await assert.rejects(runtime.service.activate(actor, { ...input, operacaoId: randomUUID() }), { statusCode: 409 });
  const response = await runtime.handler(
    new Request(`https://local.invalid${SEMOG_ACTIVATION_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer api_${'d'.repeat(16)}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), first);
  await client.recipient.update({
    where: { id: draft.signatarios[0].recipientId },
    data: { signingStatus: 'SIGNED', signedAt: new Date() },
  });
  assert.deepEqual(await runtime.service.activate(actor, input), first);
  await client.envelope.update({ where: { id: draft.envelopeId }, data: { status: 'CANCELLED' } });
  await assert.rejects(runtime.service.activate(actor, input), { statusCode: 409 });
};
const checkMutations = async (deps: Dependencies) => {
  const { client, actor, sql } = deps;
  const runtime = createSemogActivationRuntime({ enabled: true, client });
  for (const mutation of [
    'geometry',
    'name',
    'bytes',
    'signed',
    'distribution',
    'ids',
    'legacy',
    'completed',
    'rejected',
  ]) {
    const { input, draft } = await freshCase(deps);
    const id = draft.envelopeId;
    if (mutation === 'geometry') {
      await client.field.update({ where: { id: draft.signatarios[0].campos[0].fieldId }, data: { width: 99 } });
    }
    if (mutation === 'name') {
      await client.recipient.update({ where: { id: draft.signatarios[0].recipientId }, data: { name: 'Changed' } });
    }
    if (mutation === 'signed') {
      await client.recipient.update({
        where: { id: draft.signatarios[0].recipientId },
        data: { signingStatus: 'SIGNED' },
      });
    }
    if (mutation === 'rejected') {
      await client.recipient.update({
        where: { id: draft.signatarios[0].recipientId },
        data: { signingStatus: 'REJECTED' },
      });
    }
    if (mutation === 'distribution') {
      await client.documentMeta.update({
        where: { id: (await client.envelope.findUniqueOrThrow({ where: { id } })).documentMetaId },
        data: { distributionMethod: 'EMAIL' },
      });
    }
    if (mutation === 'ids') {
      await client.recipient.create({
        data: {
          envelopeId: id,
          email: 'extra@example.invalid',
          token: randomUUID(),
          role: 'CC',
          signingStatus: 'SIGNED',
        },
      });
    }
    if (mutation === 'bytes') {
      await client.documentData.update({
        where: {
          id: (await client.envelopeItem.findUniqueOrThrow({ where: { id: draft.documento.itemId } })).documentDataId,
        },
        data: { data: 'JVBERi0xLjc=' },
      });
    }
    if (mutation === 'legacy') {
      await sql(
        `UPDATE semog_bridge.draft_receipts SET estrutura=NULL WHERE "operacaoId"='${draft.operacaoId}'::uuid;`,
      );
    }
    if (mutation === 'completed') {
      await client.envelope.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    }
    await assert.rejects(runtime.service.activate(actor, input), { statusCode: 409 });
  }
  const { input } = await freshCase(deps);
  await assert.rejects(runtime.service.activate({ ...actor, userId: actor.userId + 1 }, input));
  await assert.rejects(runtime.service.activate(actor, { ...input, hashPdf: 'a'.repeat(64) }), { statusCode: 409 });
  await assert.rejects(
    runtime.service.activate(actor, { ...input, expiraEm: new Date(Date.now() - 1).toISOString() }),
    { statusCode: 409 },
  );
};
const checkActivationRollback = async (deps: Dependencies) => {
  const { client, actor, sql } = deps;
  const runtime = createSemogActivationRuntime({ enabled: true, client });
  const { input, draft } = await freshCase(deps);
  await sql(`CREATE FUNCTION semog_bridge.reject_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local activation fault'; END $$;
    CREATE TRIGGER reject_activation BEFORE INSERT ON semog_bridge.activation_receipts FOR EACH ROW EXECUTE FUNCTION semog_bridge.reject_activation();`);
  await assert.rejects(runtime.service.activate(actor, input));
  const native = await client.envelope.findUniqueOrThrow({
    where: { id: draft.envelopeId },
    include: { recipients: true },
  });
  assert.equal(native.status, 'DRAFT');
  assert(native.recipients.every((r) => r.expiresAt === null));
  await sql(
    'DROP TRIGGER reject_activation ON semog_bridge.activation_receipts; DROP FUNCTION semog_bridge.reject_activation();',
  );
  assert.equal((await runtime.service.activate(actor, input)).status, 'PENDING');
};
const checkConcurrentKeysAndRoles = async (deps: Dependencies) => {
  const { client, actor } = deps;
  const runtime = createSemogActivationRuntime({ enabled: true, client });
  const payload = await deps.draftInput();
  payload.ordemAssinatura = 'sequencial';
  payload.signatarios.push({
    referencia: randomUUID(),
    nome: 'Copy',
    email: 'cc@example.invalid',
    role: 'CC',
    ordem: 1,
    campos: [],
  });
  const draft = await createSemogDraftRuntime({ enabled: true, client }).service.create(actor, payload);
  const input = {
    operacaoId: randomUUID(),
    rascunhoOperacaoId: draft.operacaoId,
    envelopeId: draft.envelopeId,
    externalId: payload.externalId,
    hashPdf: payload.arquivo.sha256,
    expiraEm: new Date(Date.now() + 86400000).toISOString(),
  };
  const outcomes = await Promise.allSettled([
    runtime.service.activate(actor, input),
    runtime.service.activate(actor, { ...input, operacaoId: randomUUID() }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((r) => r.status === 'rejected').length, 1);
  const created = await client.envelope.findUniqueOrThrow({
    where: { id: draft.envelopeId },
    include: { recipients: true, documentMeta: true },
  });
  assert.equal(created.documentMeta.signingOrder, 'SEQUENTIAL');
  assert.equal(created.recipients.find((r) => r.role === 'CC')?.expiresAt, null);
};
export const checkSemogActivationLocal = async (deps: Dependencies) => {
  await checkReplay(deps);
  await checkMutations(deps);
  await checkActivationRollback(deps);
  await checkConcurrentKeysAndRoles(deps);
  await assert.rejects(deps.sql(await readFile('db/2026-10-07-semog-activation.down.sql', 'utf8')));
  assert.equal(await deps.client.documentAuditLog.count({ where: { type: 'DOCUMENT_SENT' } }), 0);
  assert.equal(await deps.client.backgroundJob.count(), 0);
  assert.equal((await deps.sql('SELECT count(*) FROM semog_bridge.outbox;')).trim(), '0');
};
