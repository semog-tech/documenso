import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { P12Signer, PDF } from '@libpdf/core';
import { formatter } from '@lingui/format-po';
import { compileMessageOrThrow } from '@lingui/message-utils/compileMessage';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { createSemogDocumentI18n } from '../packages/lib/server-only/semog-signing/document-pages';
import { createSemogPrismaExecutor } from '../packages/lib/server-only/semog-signing/execution';
import { createSemogPdfReader } from '../packages/lib/server-only/semog-signing/initial-pdf';
import { readSemogNativeEnvelope } from '../packages/lib/server-only/semog-signing/native-envelope';
import {
  createSemogNativeEffectDeliverer,
  createSemogOutboxWorker,
} from '../packages/lib/server-only/semog-signing/outbox';
import {
  createSemogSigningPostgresClient,
  createSemogSigningRepository,
} from '../packages/lib/server-only/semog-signing/repository';
import { createSemogSigningRuntime } from '../packages/lib/server-only/semog-signing/runtime';
import { createSemogPrismaSealer } from '../packages/lib/server-only/semog-signing/sealing';
import { createSemogSigningService } from '../packages/lib/server-only/semog-signing/service';

const container = `semog-execution-${randomUUID()}`;
const run = (args: string[], input = '', program = 'docker'): Promise<string> =>
  new Promise((resolve, reject) => {
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
        resolve(output);
      }
    });
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
const sql = (input: string) =>
  run(['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], input);
const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};
const rejected = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error('Expected rejection');
};
let client: PrismaClient | undefined;
const workspace = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), 'semog-execution-'));
const openssl = (args: string[]) => run(args, '', 'C:/Program Files/Git/usr/bin/openssl.exe');
const validateCms = async (bytes: Uint8Array) => {
  const raw = Buffer.from(bytes),
    text = raw.toString('latin1');
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  const contents = /\/Contents\s*<([a-fA-F0-9]+)>/.exec(text);
  assert(range !== null && contents !== null, 'PDF has no detached signature');
  if (!range || !contents) {
    throw new Error('Signature absent');
  }
  const [start, length, second, end] = range.slice(1).map(Number);
  await writeFile(
    join(temporary, 'content.bin'),
    Buffer.concat([raw.subarray(start, start + length), raw.subarray(second, second + end)]),
  );
  await writeFile(join(temporary, 'signature.der'), Buffer.from(contents[1], 'hex'));
  await openssl([
    'cms',
    '-verify',
    '-binary',
    '-inform',
    'DER',
    '-in',
    join(temporary, 'signature.der'),
    '-content',
    join(temporary, 'content.bin'),
    '-noverify',
    '-out',
    join(temporary, 'verified.bin'),
  ]);
};
try {
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
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert(ready, 'Postgres not ready');
  const port = (await run(['port', container, '5432'])).trim().split(':').at(-1);
  const nativeSchema = await run(
    [
      resolve(workspace, 'node_modules/prisma/build/index.js'),
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      resolve(workspace, 'packages/prisma/schema.prisma'),
      '--script',
    ],
    '',
    process.execPath,
  );
  await sql(`CREATE EXTENSION IF NOT EXISTS pg_trgm; ${nativeSchema}`);
  await sql('CREATE ROLE semog_bridge_service NOLOGIN;');
  await sql(await readFile('db/2026-10-06-semog-signing.sql', 'utf8'));
  await sql(await readFile('db/2026-10-06-semog-signing-execution.sql', 'utf8'));
  await sql(await readFile('db/2026-10-06-semog-signing-execution.down.sql', 'utf8'));
  await sql(await readFile('db/2026-10-06-semog-signing-execution.sql', 'utf8'));
  client = new PrismaClient({ datasources: { db: { url: `postgresql://postgres@127.0.0.1:${port}/postgres` } } });
  const database = client;
  const user = await database.user.create({ data: { email: 'local-owner@example.invalid', name: 'Local Owner' } });
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
  const actor = { teamId: team.id, userId: user.id };
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  const bytes = await pdf.save();
  const repository = createSemogSigningRepository(
    createSemogSigningPostgresClient({
      query: async (statement, values) => {
        // Only the fixed repository SQL allowlist produces statement text; all values remain bound.
        const rows = await database.$queryRawUnsafe<{ result: unknown }[]>(statement, ...values);
        return { rows };
      },
    }),
  );
  const readPdf = createSemogPdfReader();
  const executor = createSemogPrismaExecutor({ enabled: true, client: database, readPdf });
  const service = createSemogSigningService({
    enabled: true,
    repository,
    executor,
    readCurrent: async ({ envelopeId, actor: identity }) => {
      const current = await readSemogNativeEnvelope(database, envelopeId, identity);
      const data = current.envelope.envelopeItems[0].documentData;
      return {
        envelope: current.source,
        pdf: await readPdf({ documentDataId: data.id, type: data.type, data: data.initialData }),
      };
    },
  });
  const createFixture = async (number: number, action: 'assinar' | 'recusar') => {
    const envelopeId = randomUUID(),
      itemId = randomUUID();
    const envelope = await database.envelope.create({
      data: {
        id: envelopeId,
        secondaryId: `document_${number}`,
        title: 'Local valid PDF',
        type: 'DOCUMENT',
        source: 'DOCUMENT',
        status: 'PENDING',
        signatureLevel: 'SES',
        internalVersion: 2,
        user: { connect: { id: user.id } },
        team: { connect: { id: team.id } },
        documentMeta: {
          create: {
            language: 'pt-BR',
            timezone: null,
            dateFormat: null,
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
            documentData: {
              create: {
                type: 'BYTES_64',
                data: Buffer.from(bytes).toString('base64'),
                initialData: Buffer.from(bytes).toString('base64'),
              },
            },
          },
        },
        recipients: { create: { name: 'Local Signer', email: 'signer@example.invalid', token: randomUUID() } },
      },
      include: { recipients: true },
    });
    const recipientId = envelope.recipients[0].id;
    const field = await database.field.create({
      data: {
        envelopeId,
        envelopeItemId: itemId,
        recipientId,
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
    const observation = await database.field.create({
      data: {
        envelopeId,
        envelopeItemId: itemId,
        recipientId,
        type: 'TEXT',
        page: 1,
        positionX: 10,
        positionY: 30,
        width: 70,
        height: 10,
        customText: '',
        inserted: false,
        fieldMeta: { type: 'text', required: true, readOnly: false, characterLimit: 200, overflow: 'auto' },
      },
    });
    const snapshot = await service.enroll(actor, {
      envelopeId,
      recipientId,
      consentimento: 'Li e concordo.',
      expiraEm: '2099-01-01T00:00:00.000Z',
    });
    const input = {
      chaveOperacao: randomUUID(),
      envelopeId,
      recipientId,
      hashDocumento: snapshot.hashDocumento,
      hashConsentimento: snapshot.hashConsentimento,
      acao: action,
      motivo: action === 'recusar' ? 'Não concordo.' : null,
      campos:
        action === 'assinar'
          ? [
              { fieldId: field.id, valor: 'Local Signer' },
              { fieldId: observation.id, valor: 'Parecer: aprovado com ressalva.\nObservação exata.' },
            ]
          : [],
      evidencias: {
        canal: 'email',
        identificacaoId: 'local-verified-contact',
        confirmadoEm: new Date().toISOString(),
        ip: null,
        userAgent: null,
      },
    };
    return { envelopeId, recipientId, field, observation, snapshot, input };
  };
  const signed = await createFixture(1001, 'assinar');
  await rejected(() => database.envelope.update({ where: { id: signed.envelopeId }, data: { title: 'tampered' } }));
  await rejected(() =>
    database.recipient.update({ where: { id: signed.recipientId }, data: { email: 'other@example.invalid' } }),
  );
  await rejected(() => database.field.update({ where: { id: signed.field.id }, data: { positionX: 50 } }));
  await rejected(() => database.envelope.update({ where: { id: signed.envelopeId }, data: { status: 'DRAFT' } }));
  const result = await service.reserve(actor, signed.input);
  assert(
    result.situacao === 'concluida' && !result.documentoConcluido && !result.pdfDisponivel,
    'Signing result lies about sealing',
  );
  assert(
    (await database.recipient.findUniqueOrThrow({ where: { id: signed.recipientId } })).signingStatus === 'SIGNED',
    'Native recipient not signed',
  );
  assert(
    (await database.field.findUniqueOrThrow({ where: { id: signed.observation.id } })).customText ===
      'Parecer: aprovado com ressalva.\nObservação exata.',
    'Opinion observation changed',
  );
  assert(
    (await database.signature.findUniqueOrThrow({ where: { fieldId: signed.field.id } })).typedSignature ===
      'Local Signer',
    'Native signature absent',
  );
  const auditCount = await database.documentAuditLog.count({ where: { envelopeId: signed.envelopeId } });
  await service.reserve(actor, signed.input);
  assert(
    (await database.documentAuditLog.count({ where: { envelopeId: signed.envelopeId } })) === auditCount,
    'Replay duplicated native audit',
  );
  await rejected(() =>
    service.reserve(actor, { ...signed.input, campos: [{ fieldId: signed.field.id, valor: 'Different' }] }),
  );
  await rejected(() => executor.get({ teamId: team.id + 1, userId: user.id }, signed.input.chaveOperacao));
  const rollback = await createFixture(1002, 'assinar');
  await sql(
    `CREATE FUNCTION public.sem_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."envelopeId"='${rollback.envelopeId}' AND NEW.type='DOCUMENT_RECIPIENT_COMPLETED' THEN RAISE EXCEPTION 'local injected completion failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER sem_test_failure BEFORE INSERT ON public."DocumentAuditLog" FOR EACH ROW EXECUTE FUNCTION public.sem_test_failure();`,
  );
  await rejected(() => service.reserve(actor, rollback.input));
  assert(
    !(await database.field.findUniqueOrThrow({ where: { id: rollback.field.id } })).inserted,
    'Field did not roll back',
  );
  assert(
    (await database.signature.count({ where: { fieldId: rollback.field.id } })) === 0,
    'Signature did not roll back',
  );
  assert(
    (await database.documentAuditLog.count({ where: { envelopeId: rollback.envelopeId } })) === 0,
    'Audit did not roll back',
  );
  assert(
    (await database.recipient.findUniqueOrThrow({ where: { id: rollback.recipientId } })).signingStatus ===
      'NOT_SIGNED',
    'Recipient did not roll back',
  );
  assert(
    (await sql(`SELECT count(*) FROM semog_bridge.outbox WHERE "envelopeId"='${rollback.envelopeId}'`)).trim() === '0',
    'Outbox did not roll back',
  );
  await sql('DROP TRIGGER sem_test_failure ON public."DocumentAuditLog"; DROP FUNCTION public.sem_test_failure();');
  await service.reserve(actor, rollback.input);
  const concurrent = await createFixture(1005, 'assinar');
  const reservationOnly = createSemogSigningService({
    enabled: true,
    repository,
    readCurrent: async ({ envelopeId, actor: identity }) => {
      const current = await readSemogNativeEnvelope(database, envelopeId, identity);
      return { envelope: current.source, pdf: bytes };
    },
  });
  await reservationOnly.reserve(actor, concurrent.input);
  await Promise.all([
    executor.execute(actor, concurrent.input.chaveOperacao),
    executor.execute(actor, concurrent.input.chaveOperacao),
  ]);
  assert(
    (await database.documentAuditLog.count({ where: { envelopeId: concurrent.envelopeId } })) === 3,
    'Concurrent execution duplicated native mutations',
  );
  const refused = await createFixture(1003, 'recusar');
  await service.reserve(actor, refused.input);
  assert(
    (await database.recipient.findUniqueOrThrow({ where: { id: refused.recipientId } })).signingStatus === 'REJECTED',
    'Native refusal absent',
  );
  assert(
    (await database.signature.count({ where: { recipientId: refused.recipientId } })) === 0,
    'Refusal created signature',
  );
  const visual = await createFixture(1004, 'assinar');
  await repository.revokeSnapshot({ teamId: team.id, snapshotId: visual.snapshot.id });
  const visualEnvelope = await database.envelope.findUniqueOrThrow({ where: { id: visual.envelopeId } });
  await database.documentMeta.update({
    where: { id: visualEnvelope.documentMetaId },
    data: { drawSignatureEnabled: true },
  });
  const visualSnapshot = await service.enroll(actor, {
    envelopeId: visual.envelopeId,
    recipientId: visual.recipientId,
    consentimento: 'Li e concordo.',
    expiraEm: '2099-01-01T00:00:00.000Z',
  });
  const png = await sharp({
    create: { width: 120, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const visualInput = {
    ...visual.input,
    hashDocumento: visualSnapshot.hashDocumento,
    hashConsentimento: visualSnapshot.hashConsentimento,
    campos: visual.input.campos.filter((field) => field.fieldId !== visual.field.id),
    assinaturaVisual: {
      fieldId: visual.field.id,
      pngBase64: png.toString('base64'),
      hash: createHash('sha256').update(png).digest('hex'),
      metodo: 'desenhar',
    },
  };
  await service.reserve(actor, visualInput);
  const nativeVisual = await database.signature.findUniqueOrThrow({ where: { fieldId: visual.field.id } });
  assert(
    nativeVisual.typedSignature === null &&
      nativeVisual.signatureImageAsBase64 === `data:image/png;base64,${png.toString('base64')}`,
    'Visual signature replaced with placeholder',
  );
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
  const signer = await P12Signer.create(await readFile(join(temporary, 'cert.p12')), 'local-test-only', {
    buildChain: false,
  });
  const getDocumentI18n = createSemogDocumentI18n(async (language) => {
    const filename = resolve(workspace, 'packages/lib/translations', language, 'web.po');
    const catalog = await formatter().parse(await readFile(filename, 'utf8'), {
      locale: language,
      sourceLocale: 'en',
      filename,
    });
    return Object.fromEntries(
      Object.entries(catalog).map(([id, entry]) => [
        id,
        compileMessageOrThrow(entry.translation || entry.message || id),
      ]),
    );
  });
  const sealer = createSemogPrismaSealer({
    enabled: true,
    client: database,
    readPdf,
    signer,
    getDocumentI18n,
    rejectionFont: await readFile('apps/remix/public/fonts/noto-sans.ttf'),
  });
  process.chdir(resolve(workspace, 'apps/remix'));
  try {
    const failingSealer = createSemogPrismaSealer({
      enabled: true,
      client: database,
      readPdf,
      getDocumentI18n,
      signer: {
        certificate: signer.certificate,
        certificateChain: signer.certificateChain,
        keyType: signer.keyType,
        signatureAlgorithm: signer.signatureAlgorithm,
        sign: () => Promise.reject(new Error('local injected cryptographic failure')),
      },
    });
    await rejected(() => failingSealer.seal(actor, signed.envelopeId));
    assert(
      (await database.documentAuditLog.count({
        where: { envelopeId: signed.envelopeId, type: 'DOCUMENT_COMPLETED' },
      })) === 0,
      'Failed cryptographic seal retained completion audit',
    );
    assert(
      (await database.envelope.findUniqueOrThrow({ where: { id: signed.envelopeId } })).status === 'PENDING',
      'Failed cryptographic seal concluded envelope',
    );
    await sealer.seal(actor, signed.envelopeId);
    await sealer.seal(actor, refused.envelopeId);
    await sealer.seal(actor, visual.envelopeId);
  } finally {
    process.chdir(workspace);
  }
  const final = await database.envelope.findUniqueOrThrow({
    where: { id: signed.envelopeId },
    include: { envelopeItems: { include: { documentData: true } } },
  });
  assert(final.status === 'COMPLETED', 'Sealing did not conclude native envelope');
  const signedPdf = await readPdf({
    documentDataId: final.envelopeItems[0].documentData.id,
    type: 'BYTES_64',
    data: final.envelopeItems[0].documentData.data,
  });
  assert((await PDF.load(signedPdf)).getPageCount() >= 3, 'Native certificate/audit pages absent');
  await validateCms(signedPdf);
  assert(
    (await executor.get(actor, signed.input.chaveOperacao)).pdfDisponivel,
    'Completed PDF not available through durable operation',
  );
  await validateCms(await executor.pdf(actor, signed.input.chaveOperacao));
  const downgrade = await readFile('db/2026-10-06-semog-signing-execution.down.sql', 'utf8');
  await rejected(() => sql(downgrade));
  assert(
    (await executor.get(actor, signed.input.chaveOperacao)).pdfDisponivel,
    'Rejected downgrade did not roll back schema changes',
  );
  assert(
    (await database.envelope.findUniqueOrThrow({ where: { id: refused.envelopeId } })).status === 'REJECTED',
    'Rejected PDF not sealed',
  );
  const token = `api_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await database.apiToken.create({
    data: {
      name: 'Local disposable',
      token: createHash('sha512').update(token).digest('hex'),
      userId: user.id,
      teamId: team.id,
    },
  });
  const runtime = createSemogSigningRuntime({ enabled: true, client: database });
  const download = await runtime.handler(
    new Request(`http://local.invalid/api/semog/v1/manifestacoes/${signed.input.chaveOperacao}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  assert(
    download.status === 200 && download.headers.get('content-type') === 'application/pdf',
    'Native HTTP download failed',
  );
  await validateCms(new Uint8Array(await download.arrayBuffer()));
  const unauthorized = await runtime.handler(
    new Request(`http://local.invalid/api/semog/v1/manifestacoes/${signed.input.chaveOperacao}/pdf`),
  );
  assert(unauthorized.status === 401, 'PDF download lacked authentication');
  let firstEffect = '';
  const failing = createSemogOutboxWorker({
    enabled: true,
    client: database,
    deliver: (effect) => {
      firstEffect = effect.id;
      return Promise.reject(new Error('local retry test'));
    },
  });
  assert(!(await failing.tick()).delivered, 'Outbox falsely confirmed failed delivery');
  const capture = { jobs: 0, webhooks: 0 };
  const native = createSemogNativeEffectDeliverer({
    triggerJob: () => {
      capture.jobs++;
      return Promise.resolve();
    },
    triggerWebhook: () => {
      capture.webhooks++;
      return Promise.resolve();
    },
  });
  const worker = createSemogOutboxWorker({
    enabled: true,
    client: database,
    deliver: async (effect) => {
      if (capture.jobs + capture.webhooks === 0) {
        assert(effect.id === firstEffect, 'Retry lost durable effect id');
      }
      await native(effect);
    },
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await worker.tick()).empty) {
      break;
    }
  }
  assert(capture.jobs > 0 && capture.webhooks > 0, 'Outbox test adapters did not receive effects');
  assert(
    (await sql("SELECT count(*) FROM semog_bridge.outbox WHERE estado<>'delivered'")).trim() === '0',
    'Outbox effects not acknowledged',
  );
  console.log(
    'Outbox leases, retry IDs, native payload validation and acknowledgements passed with in-memory test adapters; no emails/webhooks sent.',
  );
  console.log(
    'Native v2 renderer + real detached CMS: cryptographic verification with local ephemeral certificate passed; initial PDF preserved; refusal stamped.',
  );
  console.log(
    'Actual Prisma catalog: native signature/refusal, audit, outbox, replay, tenant isolation, structural guards and whole-transaction rollback passed.',
  );
} finally {
  await client?.$disconnect();
  await run(['rm', '--force', container]);
  assert(resolve(temporary).startsWith(resolve(tmpdir()) + sep), 'Temporary directory outside expected root');
  await rm(temporary, { recursive: true, force: true });
}
