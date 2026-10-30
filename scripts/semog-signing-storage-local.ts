/**
 * Local proof for object storage, outbox suppression and the inline -> R2 migration. Disposable PostgreSQL 16 and
 * MinIO (S3 API) containers on loopback ports; never touches a remote database or bucket.
 *   node24 node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-storage-local.ts
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PDFDocument } from '@cantoo/pdf-lib';
import { P12Signer } from '@libpdf/core';
import { formatter } from '@lingui/format-po';
import { compileMessageOrThrow } from '@lingui/message-utils/compileMessage';
import { PrismaClient } from '@prisma/client';
import { createSemogDocumentI18n } from '../packages/lib/server-only/semog-signing/document-pages';
import type { SemogExternalEffects } from '../packages/lib/server-only/semog-signing/execution-effects';
import type { SemogPdfStore } from '../packages/lib/server-only/semog-signing/pdf-store';
import { putSemogStoredPdf } from '../packages/lib/server-only/semog-signing/pdf-store';
import { createSemogS3PdfStore } from '../packages/lib/server-only/semog-signing/pdf-store-s3';
import { createSemogSigningRuntime } from '../packages/lib/server-only/semog-signing/runtime';
import {
  backupSemogStorageRows,
  migrateSemogStorageRow,
  planSemogStorageMigration,
} from '../packages/lib/server-only/semog-signing/storage-migration';
import { checkSemogDraftPurgeRace } from './semog-signing-storage-draft-race-checks';
import { checkSemogExpiredPendingMigration } from './semog-signing-storage-expired-checks';
import { checkSemogStorageLiberacaoLocal } from './semog-signing-storage-liberacao-checks';
import { checkSemogEnrollmentRace } from './semog-signing-storage-race-checks';

const id = randomUUID();
const containers = { db: `semog-storage-db-${id}`, s3: `semog-storage-s3-${id}` };
const run = (args: string[], program = 'docker'): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise(output) : reject(new Error(output))));
    child.stdin.end();
  });
const sql = (statement: string) =>
  new Promise<string>((resolvePromise, reject) => {
    const child = spawn('docker', [
      'exec',
      '-i',
      containers.db,
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ]);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise(output.trim()) : reject(new Error(output))));
    child.stdin.end(statement);
  });
const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};
const rejects = async (fn: () => Promise<unknown>, pattern: RegExp, message: string) => {
  try {
    await fn();
  } catch (error) {
    assert(pattern.test(error instanceof Error ? error.message : String(error)), `${message}: ${String(error)}`);
    return;
  }
  throw new Error(`${message}: não recusou`);
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const workspace = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), 'semog-storage-'));
const MIGRATIONS = [
  'service-role',
  'signing',
  'signing-execution',
  'draft',
  'activation',
  'host',
  'partial-seal',
  'extension',
  'contact',
  'cancel',
  'storage',
];
const migration = async (name: string, direction: 'up' | 'down' = 'up') => {
  const { readdir } = await import('node:fs/promises');
  const file = (await readdir('db')).find((entry) =>
    entry.endsWith(direction === 'up' ? `-semog-${name}.sql` : `-semog-${name}.down.sql`),
  );
  assert(file !== undefined, `migração ${name} ausente`);
  return await sql(await readFile(join('db', file ?? ''), 'utf8'));
};
const waitFor = async (probe: () => Promise<unknown>, what: string) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await probe();
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  throw new Error(`${what} não subiu`);
};

const startServices = async () => {
  await run([
    'run',
    '-d',
    '--name',
    containers.db,
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:16-alpine',
  ]);
  await run([
    'run',
    '-d',
    '--pull',
    'never',
    '--name',
    containers.s3,
    '-p',
    '127.0.0.1::9000',
    '-e',
    'MINIO_ROOT_USER=semoglocal',
    '-e',
    'MINIO_ROOT_PASSWORD=semoglocal-only',
    'minio/minio:latest',
    'server',
    '/data',
  ]);
  await waitFor(() => run(['exec', containers.db, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']), 'PostgreSQL');
  const port = async (name: string, inner: string) => (await run(['port', name, inner])).trim().split(':').at(-1);
  const settings = {
    bucket: 'documenso-local',
    endpoint: `http://127.0.0.1:${await port(containers.s3, '9000')}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'semoglocal', secretAccessKey: 'semoglocal-only' },
  };
  const s3 = new S3Client({ ...settings, requestChecksumCalculation: 'WHEN_REQUIRED' });
  await waitFor(() => s3.send(new CreateBucketCommand({ Bucket: settings.bucket })), 'MinIO');
  return { settings, databaseUrl: `postgresql://postgres@127.0.0.1:${await port(containers.db, '5432')}/postgres` };
};
const applySchema = async () => {
  const native = await run(
    [
      resolve(workspace, 'node_modules/prisma/build/index.js'),
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      resolve(workspace, 'packages/prisma/schema.prisma'),
      '--script',
    ],
    process.execPath,
  );
  await sql(`CREATE EXTENSION IF NOT EXISTS pg_trgm; ${native}`);
  // A role that default privileges would hand EXECUTE/ALL to, like the named roles of a real cluster.
  await sql(`CREATE ROLE intruso NOLOGIN;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO intruso;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO intruso;`);
  for (const name of MIGRATIONS) {
    await migration(name);
  }
  // Rollback pair of the storage migration, then forward twice (idempotent).
  await migration('storage', 'down');
  await migration('storage');
  await migration('storage');
  // The widening on top of it: its rollback on an empty ledger, then forward twice.
  await migration('storage-liberacao', 'down');
  await migration('storage-liberacao');
  await migration('storage-liberacao');
};
const STORAGE_FUNCTIONS = [
  'semog_pdf_key(text)',
  'storage_owner(text)',
  'storage_is_bridge_envelope(text)',
  'storage_orphan_owner(text)',
  'storage_migration_eligible(text)',
  'storage_migration_allows(jsonb,jsonb)',
  'migrate_document_data_to_s3(text,text,text)',
];
/** Same check to run on production after applying: nobody but the owner may execute or touch the token table. */
const assertStorageAcl = async () => {
  // The query documented in docs/semog-signing-bridge.md for production: no row means nobody else may execute.
  const others =
    await sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN pg_roles r
    WHERE n.nspname='semog_bridge' AND r.oid<>p.proowner AND NOT r.rolsuper
      AND p.proname IN ('semog_pdf_key','storage_owner','storage_is_bridge_envelope','storage_orphan_owner',
        'storage_migration_eligible','storage_migration_allows','migrate_document_data_to_s3')
      AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`);
  assert(others === '0', `papéis com EXECUTE nas funções de armazenamento: ${others}`);
  for (const fn of ['guard_native_mutation()', 'guard_suppressed_effect()']) {
    const granted = await sql(`SELECT has_function_privilege('intruso','semog_bridge.${fn}','EXECUTE')`);
    assert(granted === 'f', `intruso pode executar a função de trigger ${fn}`);
  }
  for (const role of ['intruso', 'semog_bridge_service']) {
    for (const fn of STORAGE_FUNCTIONS) {
      const granted = await sql(`SELECT has_function_privilege('${role}','semog_bridge.${fn}','EXECUTE')`);
      assert(granted === 'f', `${role} pode executar ${fn}`);
    }
    const table = await sql(
      `SELECT has_table_privilege('${role}','semog_bridge.storage_migration_tokens','INSERT,SELECT,UPDATE,DELETE')`,
    );
    assert(table === 'f', `${role} acessa a tabela de tokens`);
  }
};
const createSigner = async () => {
  const openssl = (args: string[]) => run(args, 'C:/Program Files/Git/usr/bin/openssl.exe');
  await openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(temporary, 'key.pem'),
    '-out',
    join(temporary, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=Semog local test only',
  ]);
  await openssl([
    'pkcs12',
    '-export',
    '-out',
    join(temporary, 'cert.p12'),
    '-inkey',
    join(temporary, 'key.pem'),
    '-in',
    join(temporary, 'cert.pem'),
    '-passout',
    'pass:local-test-only',
  ]);
  return await P12Signer.create(await readFile(join(temporary, 'cert.p12')), 'local-test-only', { buildChain: false });
};
const documentI18n = createSemogDocumentI18n(async (language) => {
  const filename = resolve(workspace, 'packages/lib/translations', language, 'web.po');
  const catalog = await formatter().parse(await readFile(filename, 'utf8'), {
    locale: language,
    sourceLocale: 'en',
    filename,
  });
  return Object.fromEntries(
    Object.entries(catalog).map(([key, entry]) => [
      key,
      compileMessageOrThrow(entry.translation || entry.message || key),
    ]),
  );
});

type Database = PrismaClient;
const createTeam = async (database: Database) => {
  const user = await database.user.create({ data: { email: `owner-${randomUUID()}@example.invalid`, name: 'Local' } });
  const organisation = await database.organisation.create({
    data: {
      id: randomUUID(),
      name: 'Local Semog',
      url: randomUUID(),
      type: 'ORGANISATION',
      owner: { connect: { id: user.id } },
      organisationClaim: {
        create: {
          id: randomUUID(),
          teamCount: 1,
          memberCount: 1,
          envelopeItemCount: 10,
          recipientCount: 10,
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
  const team = await database.team.create({
    data: {
      name: 'Local',
      url: randomUUID(),
      organisation: { connect: { id: organisation.id } },
      teamGlobalSettings: { create: { id: randomUUID() } },
    },
  });
  return { teamId: team.id, userId: user.id };
};
const createEnvelope = async (
  database: Database,
  actor: { teamId: number; userId: number },
  number: number,
  document: { type: 'BYTES_64' | 'S3_PATH'; data: string },
) => {
  const envelopeId = randomUUID(),
    itemId = randomUUID();
  const envelope = await database.envelope.create({
    data: {
      id: envelopeId,
      secondaryId: `document_${number}`,
      title: 'Local',
      type: 'DOCUMENT',
      source: 'DOCUMENT',
      status: 'PENDING',
      signatureLevel: 'SES',
      internalVersion: 2,
      user: { connect: { id: actor.userId } },
      team: { connect: { id: actor.teamId } },
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
          documentData: { create: { ...document, initialData: document.data } },
        },
      },
      recipients: { create: { name: 'Signer', email: 'signer@example.invalid', token: randomUUID() } },
    },
    include: { recipients: true },
  });
  const field = await database.field.create({
    data: {
      envelopeId,
      envelopeItemId: itemId,
      recipientId: envelope.recipients[0].id,
      type: 'SIGNATURE',
      page: 1,
      positionX: 10,
      positionY: 10,
      width: 30,
      height: 10,
      customText: '',
      inserted: false,
      fieldMeta: { type: 'signature', overflow: 'auto' },
    },
  });
  return { envelopeId, recipientId: envelope.recipients[0].id, fieldId: field.id };
};
type Runtime = ReturnType<typeof createSemogSigningRuntime>;
const signAndSeal = async (
  runtime: Runtime,
  actor: { teamId: number; userId: number },
  fixture: Awaited<ReturnType<typeof createEnvelope>>,
  seal: boolean,
) => {
  const snapshot = await runtime.service.enroll(actor, {
    envelopeId: fixture.envelopeId,
    recipientId: fixture.recipientId,
    consentimento: 'Li e concordo.',
    expiraEm: '2099-01-01T00:00:00.000Z',
  });
  if (!seal) {
    return null;
  }
  const chaveOperacao = randomUUID();
  const result = await runtime.service.reserve(actor, {
    chaveOperacao,
    envelopeId: fixture.envelopeId,
    recipientId: fixture.recipientId,
    hashDocumento: snapshot.hashDocumento,
    hashConsentimento: snapshot.hashConsentimento,
    acao: 'assinar',
    motivo: null,
    campos: [{ fieldId: fixture.fieldId, valor: 'Signer' }],
    evidencias: {
      canal: 'email',
      identificacaoId: 'local',
      confirmadoEm: new Date().toISOString(),
      ip: null,
      userAgent: null,
    },
  });
  assert(result.situacao === 'concluida', 'assinatura não concluída');
  process.chdir(resolve(workspace, 'apps/remix'));
  try {
    await runtime.sealer.seal(actor, fixture.envelopeId);
  } finally {
    process.chdir(workspace);
  }
  return chaveOperacao;
};

const outboxStates = async (envelopeId: string) =>
  await sql(
    `SELECT string_agg(kind||':'||estado, ',' ORDER BY kind, id) FROM semog_bridge.outbox WHERE "envelopeId"='${envelopeId}'`,
  );

let client: PrismaClient | undefined;
try {
  const { settings, databaseUrl } = await startServices();
  await applySchema();
  client = new PrismaClient({ datasourceUrl: databaseUrl });
  const database = client;
  const store: SemogPdfStore = createSemogS3PdfStore(settings);
  const signer = await createSigner();
  const rejectionFont = await readFile('apps/remix/public/fonts/noto-sans.ttf');
  const runtimeWith = (pdfStore: SemogPdfStore | undefined, externalEffects: SemogExternalEffects) =>
    createSemogSigningRuntime({
      enabled: true,
      client: database,
      pdfStore,
      externalEffects,
      signer,
      rejectionFont,
      getDocumentI18n: documentI18n,
    });
  const actor = await createTeam(database);
  const document = await PDFDocument.create();
  document.addPage([600, 800]);
  const pdf = await document.save();
  const inline = { type: 'BYTES_64' as const, data: Buffer.from(pdf).toString('base64') };

  // 1. Legacy inline envelopes, before the outbox migration: effects are recorded 'pendente' as they always were.
  // 'suppress' requested, migration absent: every write falls back to 'pendente' on its own.
  const legacy = runtimeWith(undefined, 'suppress');
  const finished = await createEnvelope(database, actor, 9001, inline);
  const finishedKey = await signAndSeal(legacy, actor, finished, true);
  const pending = await createEnvelope(database, actor, 9002, inline);
  await signAndSeal(legacy, actor, pending, false);
  await sql(
    `UPDATE semog_bridge.outbox SET estado='delivered' WHERE kind='seal' AND "envelopeId"='${finished.envelopeId}'`,
  );
  assert(
    (await outboxStates(finished.envelopeId)).includes('job:pendente'),
    'efeitos legados deveriam estar pendentes',
  );

  // 2. Outbox migration: backfill marks pending job/webhook effects 'suprimido'; the state is final; down refuses.
  const outboxUp = await readFile('db/2026-10-31-semog-outbox-suprimido.sql', 'utf8');
  await sql(outboxUp);
  await sql(outboxUp);
  const afterBackfill = await outboxStates(finished.envelopeId);
  assert(
    !afterBackfill.includes('job:pendente') && !afterBackfill.includes('webhook:pendente'),
    `backfill incompleto: ${afterBackfill}`,
  );
  assert(afterBackfill.includes('seal:delivered'), 'a selagem não pode ser suprimida');
  await rejects(
    () => sql(`UPDATE semog_bridge.outbox SET estado='pendente' WHERE estado='suprimido'`),
    /final and is never delivered/,
    'suprimido virou pendente',
  );
  const outboxDown = await readFile('db/2026-10-31-semog-outbox-suprimido.down.sql', 'utf8');
  await rejects(() => sql(outboxDown), /re-arm/, 'down sem recusa');
  assert(
    (await sql('SELECT public.semog_signing_claim_effect(120) IS NULL')) === 't',
    'claim entregou efeito suprimido',
  );

  // 3. Object storage end to end, with suppression: R2-like bucket, reads outside transactions, native download.
  const objects = runtimeWith(store, 'suppress');
  const stored = await putSemogStoredPdf(store, pdf);
  const s3Envelope = await createEnvelope(database, actor, 9003, stored);
  const s3Key = await signAndSeal(objects, actor, s3Envelope, true);
  const states = await outboxStates(s3Envelope.envelopeId);
  assert(
    /job:suprimido/.test(states) && /webhook:suprimido/.test(states) && /seal:pendente/.test(states),
    `estados: ${states}`,
  );
  const sealedItem = await database.envelopeItem.findFirstOrThrow({
    where: { envelopeId: s3Envelope.envelopeId },
    include: { documentData: true },
  });
  assert(
    sealedItem.documentData.type === 'S3_PATH' && sealedItem.documentData.initialData === stored.data,
    'selado fora do R2 ou original recopiado',
  );
  assert(s3Key !== null && (await objects.executor.get(actor, s3Key)).pdfDisponivel, 'PDF selado indisponível (S3)');
  const sealedBytes = await objects.executor.pdf(actor, s3Key ?? '');
  assert(
    sealedItem.documentData.data === `semog/pdf/${sha256(sealedBytes)}.pdf`,
    'chave do selado não é o hash dos bytes',
  );
  Object.assign(process.env, {
    NEXT_PUBLIC_UPLOAD_TRANSPORT: 's3',
    NEXT_PRIVATE_UPLOAD_BUCKET: settings.bucket,
    NEXT_PRIVATE_UPLOAD_ENDPOINT: settings.endpoint,
    NEXT_PRIVATE_UPLOAD_REGION: settings.region,
    NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE: 'true',
    NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID: settings.credentials.accessKeyId,
    NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY: settings.credentials.secretAccessKey,
  });
  const { getFileServerSide } = await import('../packages/lib/universal/upload/get-file.server');
  const nativeDownload = await getFileServerSide({ type: 'S3_PATH', data: sealedItem.documentData.data });
  assert(Buffer.from(nativeDownload).equals(Buffer.from(sealedBytes)), 'download nativo do selado diverge');

  // 4. Migration of the legacy rows: plan, refusals, upload + read-back, guard-approved swap, still verifiable.
  const finishedItem = await database.envelopeItem.findFirstOrThrow({
    where: { envelopeId: finished.envelopeId },
    include: { documentData: true },
  });
  const sealedInline = Buffer.from(finishedItem.documentData.data, 'base64');
  const stray = await PDFDocument.create();
  stray.addPage([300, 300]);
  const strayBase64 = Buffer.from(await stray.save()).toString('base64');
  await sql(
    `INSERT INTO public."DocumentData"(id,type,data,"initialData") VALUES('stray','BYTES_64','${strayBase64}','${strayBase64}')`,
  );
  const plan = await planSemogStorageMigration(database);
  const byId = new Map(plan.map((row) => [row.id, row]));
  const pendingItem = await database.envelopeItem.findFirstOrThrow({ where: { envelopeId: pending.envelopeId } });
  assert(byId.get(finishedItem.documentDataId)?.eligible === true, 'selado concluído deveria ser elegível');
  assert(byId.get(pendingItem.documentDataId)?.eligible === false, 'envelope pendente não pode ser elegível');
  assert(
    plan.some((row) => row.orfa && row.envelopeId === finished.envelopeId && row.eligible),
    'original órfão (pós-selagem) da ponte deveria aparecer elegível',
  );
  const strayRow = plan.find((row) => row.id === 'stray');
  assert(strayRow?.eligible === false && strayRow.envelopeId === null, 'órfã sem vínculo deveria ficar de fora');
  await rejects(
    () => migrateSemogStorageRow(database, store, strayRow ?? plan[0]),
    /not linked/,
    'migrou órfã sem vínculo',
  );
  // Right keys, forged session mark: without the function's token in its table the guard still refuses.
  await rejects(
    () =>
      sql(`BEGIN; SELECT set_config('semog_bridge.storage_migration',gen_random_uuid()::text,true);
        UPDATE public."DocumentData" SET type='S3_PATH', data=semog_bridge.semog_pdf_key(data),
          "initialData"=semog_bridge.semog_pdf_key("initialData") WHERE id='${finishedItem.documentDataId}'; COMMIT;`),
    /immutable/,
    'marca de sessão forjada passou pela guarda',
  );
  await assertStorageAcl();
  await rejects(
    () =>
      sql(
        `UPDATE public."DocumentData" SET type='S3_PATH', data='semog/pdf/x.pdf', "initialData"='semog/pdf/x.pdf' WHERE id='${finishedItem.documentDataId}'`,
      ),
    /immutable/,
    'guarda deixou UPDATE direto passar',
  );
  const pendingRow = byId.get(pendingItem.documentDataId);
  await rejects(
    () => migrateSemogStorageRow(database, store, pendingRow ?? plan[0]),
    /not eligible/,
    'migrou envelope pendente',
  );
  const eligible = plan.filter((row) => row.eligible);
  const backup = join(temporary, 'backup.jsonl');
  await backupSemogStorageRows(
    database,
    eligible.map((row) => row.id),
    backup,
  );
  assert((await readFile(backup, 'utf8')).trim().split('\n').length === eligible.length, 'backup incompleto');
  for (const row of eligible) {
    await migrateSemogStorageRow(database, store, row);
  }
  const migrated = await database.documentData.findUniqueOrThrow({ where: { id: finishedItem.documentDataId } });
  assert(
    migrated.type === 'S3_PATH' && migrated.data === `semog/pdf/${sha256(sealedInline)}.pdf`,
    'linha não migrada para a chave do hash',
  );
  assert(
    finishedKey !== null && (await objects.executor.get(actor, finishedKey)).pdfDisponivel,
    'envelope migrado deixou de ser verificável',
  );
  assert(
    Buffer.from(await objects.executor.pdf(actor, finishedKey ?? '')).equals(sealedInline),
    'PDF migrado diverge do inline',
  );
  const migratedNative = await getFileServerSide({ type: 'S3_PATH', data: migrated.data });
  assert(Buffer.from(migratedNative).equals(sealedInline), 'download nativo do migrado diverge');
  assert(
    (await planSemogStorageMigration(database)).every((row) => !row.eligible),
    'restou linha elegível após migrar',
  );

  // 5. db/2026-11-01-semog-storage-liberacao: PENDING/CANCELLED migration, cancelled guard, purge, CLI, sweep, ACL.
  let envelopeNumber = 9100;
  const labelledPdf = async (label: string) => {
    const labelled = await PDFDocument.create();
    labelled.setTitle(label);
    labelled.addPage([600, 800]);
    return await labelled.save();
  };
  await checkSemogStorageLiberacaoLocal({
    client: database,
    actor,
    databaseUrl,
    settings,
    store,
    sql,
    migration,
    createEnvelope: (document) => createEnvelope(database, actor, envelopeNumber++, document),
    signAndSeal: (fixture, seal) => signAndSeal(objects, actor, fixture, seal),
    pdf: labelledPdf,
  });
  // 6. Enrollment racing the migration: the stale snapshot is refused; the service reads again once.
  await checkSemogEnrollmentRace({
    client: database,
    actor,
    store,
    sql,
    createInline: async (bytes) => {
      const fixture = await createEnvelope(database, actor, envelopeNumber++, {
        type: 'BYTES_64',
        data: Buffer.from(bytes).toString('base64'),
      });
      await sql(`INSERT INTO semog_bridge.draft_receipts("operacaoId","externalId","teamId","userId",hash,"envelopeId",resultado)
        VALUES(gen_random_uuid(),gen_random_uuid(),${actor.teamId},${actor.userId},repeat('a',64),'${fixture.envelopeId}','{}')`);
      return fixture;
    },
    pdf: labelledPdf,
  });
  // 7. A draft reusing a cancelled envelope's object while the purge removes it: put back after the commit.
  await checkSemogDraftPurgeRace({
    client: database,
    actor,
    settings,
    sql,
    createEnvelope: (document) => createEnvelope(database, actor, envelopeNumber++, document),
    pdf: labelledPdf,
  });
  // 8. Expired enrollment: migrate PENDING, partial seal, extension, new enrollment, signature, final seal.
  await checkSemogExpiredPendingMigration({
    client: database,
    actor,
    store,
    sql,
    runtimeFor: (pdfStore) => runtimeWith(pdfStore, 'suppress'),
    inAppDirectory: async (render) => {
      process.chdir(resolve(workspace, 'apps/remix'));
      try {
        return await render();
      } finally {
        process.chdir(workspace);
      }
    },
    pdf: labelledPdf,
  });

  process.stdout.write(
    'Storage local: R2-like bucket end to end (sign, seal, native download), outbox suppression + backfill + final state, inline -> S3 migration through the guard, and the space release (PENDING/CANCELLED migration, cancelled guard, retention purge, CLI, sweep, ACL, down/up), the enrollment race (stale snapshot refused, service reads again), the draft/purge race and the expired-enrollment round (migrate, partial seal, extension, re-enroll, sign, seal) passed.\n',
  );
} finally {
  await client?.$disconnect();
  await run(['rm', '--force', containers.db, containers.s3]).catch((error: unknown) => {
    process.stderr.write(`limpeza dos containers falhou: ${String(error)}\n`);
  });
  assert(resolve(temporary).startsWith(resolve(tmpdir()) + sep), 'Temporary directory outside expected root');
  await rm(temporary, { recursive: true, force: true });
}
