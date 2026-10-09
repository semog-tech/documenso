import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { PrismaClient } from '@prisma/client';
import { ZSemogDraftRequest, ZSemogDraftResult } from '../packages/lib/server-only/semog-signing/draft-contract';
import { SEMOG_DRAFT_PATH } from '../packages/lib/server-only/semog-signing/draft-http';
import { createSemogDraftRuntime } from '../packages/lib/server-only/semog-signing/draft-runtime';
import { checkSemogActivationLocal } from './semog-signing-activation-checks';

const container = `semog-draft-${randomUUID()}`;
const run = (args: string[], input = '', program = 'docker'): Promise<string> =>
  new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(output));
      } else {
        resolveResult(output);
      }
    });
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
const sql = (input: string) =>
  run(['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], input);
const initializeDatabase = async () => {
  await run([
    'run',
    '--detach',
    '--name',
    container,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:16-alpine',
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await run(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
      ready = true;
      break;
    } catch {
      await new Promise((resolveReady) => setTimeout(resolveReady, 200));
    }
  }
  assert(ready, 'Local PostgreSQL unavailable');
  const schema = await run(
    [
      resolve('node_modules/prisma/build/index.js'),
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      resolve('packages/prisma/schema.prisma'),
      '--script',
    ],
    '',
    process.execPath,
  );
  await sql(`CREATE EXTENSION pg_trgm; ${schema}`);
  await sql('CREATE ROLE semog_bridge_service NOLOGIN;');
  await sql(await readFile('db/2026-10-06-semog-signing.sql', 'utf8'));
  await sql(await readFile('db/2026-10-06-semog-signing-execution.sql', 'utf8'));
  const up = await readFile('db/2026-10-07-semog-draft.sql', 'utf8');
  await sql(up);
  await sql(await readFile('db/2026-10-07-semog-draft.down.sql', 'utf8'));
  await sql(up);
  const activation = await readFile('db/2026-10-07-semog-activation.sql', 'utf8');
  await sql(activation);
  await sql(await readFile('db/2026-10-07-semog-activation.down.sql', 'utf8'));
  await sql(activation);
  const port = (await run(['port', container, '5432'])).trim().split(':').at(-1);
  return new PrismaClient({ datasources: { db: { url: `postgresql://postgres@127.0.0.1:${port}/postgres` } } });
};
const createActor = async (client: PrismaClient) => {
  const user = await client.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const organisation = await client.organisation.create({
    data: {
      id: randomUUID(),
      name: 'Disposable local',
      url: randomUUID(),
      type: 'ORGANISATION',
      owner: { connect: { id: user.id } },
      organisationClaim: {
        create: {
          id: randomUUID(),
          teamCount: 1,
          memberCount: 1,
          envelopeItemCount: 10,
          recipientCount: 100,
          flags: {},
          documentRateLimits: [],
          emailRateLimits: [],
          apiRateLimits: [],
        },
      },
      organisationGlobalSettings: {
        create: {
          id: randomUUID(),
          emailDocumentSettings: {
            recipientSigningRequest: false,
            recipientRemoved: false,
            recipientSigned: false,
            documentPending: false,
            documentCompleted: false,
            documentDeleted: false,
            ownerDocumentCompleted: false,
            ownerRecipientExpired: false,
            ownerDocumentCreated: false,
          },
        },
      },
      organisationAuthenticationPortal: { create: { id: randomUUID() } },
    },
  });
  const team = await client.team.create({
    data: {
      name: 'Disposable',
      url: randomUUID(),
      organisation: { connect: { id: organisation.id } },
      teamGlobalSettings: { create: { id: randomUUID() } },
    },
  });
  return { teamId: team.id, userId: user.id };
};
const draftInput = async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  return {
    operacaoId: randomUUID(),
    externalId: randomUUID(),
    versao: 1,
    ordemAssinatura: 'paralela',
    titulo: 'Local only',
    arquivo: {
      nome: 'local.pdf',
      pdfBase64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    signatarios: [
      {
        referencia: randomUUID(),
        nome: 'Local',
        email: 'recipient@example.invalid',
        cargo: 'Síndico',
        ordem: 0,
        role: 'SIGNER',
        campos: [
          {
            referencia: randomUUID(),
            tipo: 'TEXT',
            papel: 'cpf',
            pagina: 1,
            x: 10,
            y: 10,
            largura: 20,
            altura: 5,
            obrigatorio: true,
          },
          {
            referencia: randomUUID(),
            tipo: 'TEXT',
            papel: 'observacao',
            pagina: 1,
            x: 10,
            y: 20,
            largura: 20,
            altura: 5,
            obrigatorio: false,
          },
          {
            referencia: randomUUID(),
            tipo: 'SIGNATURE',
            papel: 'assinatura',
            pagina: 1,
            x: 10,
            y: 30,
            largura: 20,
            altura: 5,
            obrigatorio: true,
          },
        ],
      },
    ],
  };
};
const checkRealTransactions = async (client: PrismaClient) => {
  await client.counter.create({ data: { id: 'document', value: 0 } });
  const actor = await createActor(client);
  const other = await createActor(client);
  const token = `api_${'d'.repeat(16)}`;
  await client.apiToken.create({
    data: {
      name: 'Disposable',
      token: createHash('sha512').update(token).digest('hex'),
      userId: actor.userId,
      teamId: actor.teamId,
    },
  });
  const runtime = createSemogDraftRuntime({ enabled: true, client });
  const input = await draftInput();
  const [first, second] = await Promise.all([
    runtime.service.create(actor, input),
    runtime.service.create(actor, input),
  ]);
  assert.deepEqual(first, second, 'Concurrent replay returned two envelopes');
  assert.deepEqual(await runtime.service.create(actor, input), first);
  await assert.rejects(runtime.service.create(actor, { ...input, titulo: 'Different' }));
  await assert.rejects(runtime.service.create(actor, { ...input, operacaoId: randomUUID() }));
  await assert.rejects(runtime.service.create(other, input));
  assert.equal(await client.envelope.count(), 1);
  const envelope = await client.envelope.findUniqueOrThrow({
    where: { id: first.envelopeId },
    include: { recipients: true, fields: true, documentMeta: true, envelopeItems: { include: { documentData: true } } },
  });
  assert.equal(envelope.status, 'DRAFT');
  assert.equal(envelope.documentMeta?.distributionMethod, 'NONE');
  assert.equal(envelope.documentMeta?.language, 'pt-BR');
  assert(
    envelope.recipients.every(
      (recipient) =>
        recipient.sendStatus === 'NOT_SENT' &&
        recipient.readStatus === 'NOT_OPENED' &&
        recipient.signingStatus === 'NOT_SIGNED',
    ),
  );
  assert(envelope.fields.every((field) => !field.inserted));
  assert.equal(envelope.envelopeItems[0].documentData.initialData, input.arquivo.pdfBase64);
  assert.equal(await client.documentAuditLog.count({ where: { type: 'DOCUMENT_CREATED' } }), 1);
  assert.equal(await client.documentAuditLog.count({ where: { type: 'DOCUMENT_SENT' } }), 0);
  const outbox = await client.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM semog_bridge.outbox`;
  assert.equal(Number(outbox[0].count), 0);
  const http = await runtime.handler(
    new Request(`http://local.invalid${SEMOG_DRAFT_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
  assert.equal(http.status, 200);
  assert.deepEqual(ZSemogDraftResult.parse(await http.json()), first);
  const conflict = await runtime.handler(
    new Request(`http://local.invalid${SEMOG_DRAFT_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, titulo: 'Conflict' }),
    }),
  );
  assert.equal(conflict.status, 409);
  await sql('CREATE ROLE semog_draft_untrusted NOLOGIN;');
  const privilege = await sql(
    "SELECT has_table_privilege('semog_draft_untrusted','semog_bridge.draft_receipts','SELECT');",
  );
  assert.equal(privilege.trim(), 'f');
  await assert.rejects(sql(await readFile('db/2026-10-07-semog-draft.down.sql', 'utf8')));
  return { runtime, actor };
};
const checkRollback = async (client: PrismaClient, actor: { teamId: number; userId: number }) => {
  const initial = await client.envelope.count();
  await sql(`CREATE FUNCTION public.semog_test_fail_draft_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local injected failure'; END $$;
    CREATE TRIGGER semog_test_fail_draft_receipt BEFORE INSERT ON semog_bridge.draft_receipts FOR EACH ROW EXECUTE FUNCTION public.semog_test_fail_draft_receipt();`);
  const runtime = createSemogDraftRuntime({ enabled: true, client });
  const input = await draftInput();
  await assert.rejects(runtime.service.create(actor, input));
  assert.equal(await client.envelope.count(), initial, 'Failed receipt left an envelope behind');
  assert.equal(await client.documentData.count(), initial, 'Failed receipt left a PDF behind');
  await sql(
    'DROP TRIGGER semog_test_fail_draft_receipt ON semog_bridge.draft_receipts; DROP FUNCTION public.semog_test_fail_draft_receipt();',
  );
  const retried = await runtime.service.create(actor, input);
  assert.equal(retried.status, 'DRAFT');
};
const checkSequentialRoles = async (client: PrismaClient, actor: { teamId: number; userId: number }) => {
  const input = ZSemogDraftRequest.parse(await draftInput());
  input.ordemAssinatura = 'sequencial';
  input.versao = 3;
  input.signatarios[0].ordem = 1;
  for (const role of ['APPROVER', 'VIEWER', 'CC', 'ASSISTANT'] satisfies (
    | 'APPROVER'
    | 'VIEWER'
    | 'CC'
    | 'ASSISTANT'
  )[]) {
    input.signatarios.push({
      referencia: randomUUID(),
      nome: role,
      email: `${role.toLowerCase()}@example.invalid`,
      role,
      ordem: role === 'ASSISTANT' ? 0 : input.signatarios.length + 1,
      campos: role === 'ASSISTANT' ? [{ ...input.signatarios[0].campos[0], referencia: randomUUID() }] : [],
    });
  }
  const runtime = createSemogDraftRuntime({ enabled: true, client });
  const result = await runtime.service.create(actor, input);
  const created = await client.envelope.findUniqueOrThrow({
    where: { id: result.envelopeId },
    include: { documentMeta: true, recipients: true },
  });
  assert.equal(created.documentMeta?.signingOrder, 'SEQUENTIAL');
  assert.equal(created.recipients.length, 5);
  assert(created.recipients.every((recipient) => recipient.sendStatus === 'NOT_SENT' && !recipient.sentAt));
  assert.equal(created.recipients.find((recipient) => recipient.role === 'CC')?.signingStatus, 'SIGNED');
};
let client: PrismaClient | undefined;
try {
  client = await initializeDatabase();
  const { runtime, actor } = await checkRealTransactions(client);
  await checkSequentialRoles(client, actor);
  await checkRollback(client, actor);
  await checkSemogActivationLocal({
    client,
    actor,
    sql,
    draftInput: async () => ZSemogDraftRequest.parse(await draftInput()),
  });
  // Valid PDF with trailing PDF whitespace exceeds 15 MiB, proving the native default is not the old 8 MiB body cap.
  const large = await draftInput();
  const bytes = Buffer.concat([Buffer.from(large.arquivo.pdfBase64, 'base64'), Buffer.alloc(16 * 1024 * 1024, 32)]);
  large.arquivo = {
    nome: 'large-local.pdf',
    pdfBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  assert.equal((await runtime.service.create(actor, large)).status, 'DRAFT');
  process.stdout.write(
    'PASS: local PostgreSQL draft + activation up/down/up, concurrency/replay/conflict/isolation, native API token HTTP, structural/legacy/terminal guards, PDF >15 MiB, atomic rollback and no outbox/distribution effects.\n',
  );
} finally {
  await client?.$disconnect();
  await run(['rm', '--force', container]);
}
