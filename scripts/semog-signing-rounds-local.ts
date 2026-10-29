/**
 * Disposable PostgreSQL rehearsal of the closing rounds (partial seal and, later, deadline extension).
 * Uses local PostgreSQL binaries instead of Docker: SEMOG_PG_BIN (default /opt/homebrew/bin) and an
 * optional SEMOG_PG_PARENT for the throwaway data directory. Never reads .env; removes everything at exit.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { P12Signer, PDF } from '@libpdf/core';
import { setupI18n } from '@lingui/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { createSemogPdfReader } from '../packages/lib/server-only/semog-signing/initial-pdf';
import { createSemogPartialSealService } from '../packages/lib/server-only/semog-signing/partial-seal-service';

const workspace = process.cwd();
const pgBin = process.env.SEMOG_PG_BIN ?? '/opt/homebrew/bin';
const root = await mkdtemp(join(process.env.SEMOG_PG_PARENT ?? tmpdir(), 'semog-rounds-'));
const port = 20000 + Math.floor(Math.random() * 30000);
const run = (program: string, args: string[], input = ''): Promise<string> =>
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
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(output));
      } else {
        resolvePromise(output);
      }
    });
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
const sql = (input: string) =>
  run(
    join(pgBin, 'psql'),
    ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
    input,
  );
const check = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(`FAILED: ${message}`);
  }
  console.log(`ok - ${message}`);
};
const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const startDatabase = async () => {
  await run(join(pgBin, 'initdb'), ['-D', join(root, 'data'), '-U', 'postgres', '--auth=trust']);
  await run(join(pgBin, 'pg_ctl'), [
    '-D',
    join(root, 'data'),
    '-o',
    `-p ${port} -c unix_socket_directories='' -c listen_addresses=127.0.0.1`,
    '-l',
    join(root, 'log.txt'),
    '-w',
    'start',
  ]);
  const nativeSchema = await run(process.execPath, [
    resolve(workspace, 'node_modules/prisma/build/index.js'),
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema-datamodel',
    resolve(workspace, 'packages/prisma/schema.prisma'),
    '--script',
  ]);
  await sql(`CREATE EXTENSION IF NOT EXISTS pg_trgm; ${nativeSchema}`);
  for (const migration of [
    '2026-10-08-semog-service-role',
    '2026-10-06-semog-signing',
    '2026-10-06-semog-signing-execution',
    '2026-10-07-semog-draft',
    '2026-10-07-semog-activation',
    '2026-10-07-semog-host',
    '2026-10-29-semog-partial-seal',
  ]) {
    await sql(await readFile(`db/${migration}.sql`, 'utf8'));
  }
};

const createTeam = async (database: PrismaClient) => {
  const user = await database.user.create({ data: { email: `owner-${randomUUID()}@example.invalid`, name: 'Owner' } });
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
  return { user, team, actor: { teamId: team.id, userId: user.id } };
};

const buildPdf = async () => {
  const pdf = await PDF.load(await readFile(resolve(workspace, 'assets/example.pdf')));
  const blank = await PDF.load(await readFile(resolve(workspace, 'assets/a4-size.pdf')));
  await pdf.copyPagesFrom(blank, [0]);
  return Buffer.from(await pdf.save()).toString('base64');
};

type Team = Awaited<ReturnType<typeof createTeam>>;
/** Five SIGNER recipients, parallel order, one SIGNATURE field each, activated by the bridge. */
const createEnvelope = async (database: PrismaClient, owner: Team, expiresAt: Date) => {
  const base64 = await buildPdf();
  const envelopeId = `envelope_${randomUUID().replaceAll('-', '')}`;
  const itemId = `item_${randomUUID().slice(0, 8)}`;
  await database.envelope.create({
    data: {
      id: envelopeId,
      secondaryId: `document_${Math.floor(Math.random() * 1e9)}`,
      title: 'Prestação de contas (ensaio local)',
      type: 'DOCUMENT',
      source: 'DOCUMENT',
      status: 'PENDING',
      signatureLevel: 'SES',
      internalVersion: 2,
      user: { connect: { id: owner.user.id } },
      team: { connect: { id: owner.team.id } },
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
          title: 'prestacao.pdf',
          order: 0,
          documentData: { create: { type: 'BYTES_64', data: base64, initialData: base64 } },
        },
      },
    },
  });
  const recipients = [];
  for (const index of [1, 2, 3, 4, 5]) {
    const recipient = await database.recipient.create({
      data: {
        envelopeId,
        email: `conselheiro${index}@example.invalid`,
        name: `Conselheiro ${index}`,
        token: randomUUID(),
        role: 'SIGNER',
        expiresAt,
      },
    });
    const field = await database.field.create({
      data: {
        envelopeId,
        envelopeItemId: itemId,
        recipientId: recipient.id,
        type: 'SIGNATURE',
        page: 1,
        positionX: 8,
        positionY: 5 + index * 15,
        width: 30,
        height: 8,
        customText: '',
        inserted: false,
        fieldMeta: { type: 'signature', overflow: 'auto' },
      },
    });
    recipients.push({ recipient, field });
  }
  const draft = randomUUID();
  const hash = 'a'.repeat(64);
  await database.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.draft_receipts ("operacaoId","externalId","teamId","userId",hash,"envelopeId",resultado)
    VALUES (${draft}::uuid,${randomUUID()}::uuid,${owner.team.id},${owner.user.id},${hash},${envelopeId},'{}'::jsonb)`);
  await database.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.activation_receipts ("operacaoId","rascunhoOperacaoId","envelopeId","teamId","userId",hash,resultado)
    VALUES (${randomUUID()}::uuid,${draft}::uuid,${envelopeId},${owner.team.id},${owner.user.id},${hash},'{}'::jsonb)`);
  return { envelopeId, recipients };
};

type Envelope = Awaited<ReturnType<typeof createEnvelope>>;
/** Native-equivalent signature written under the same envelope lock the bridge executor takes. */
const signNatively = async (tx: Prisma.TransactionClient, entry: Envelope['recipients'][number]) => {
  await tx.field.update({ where: { id: entry.field.id }, data: { inserted: true } });
  await tx.signature.create({
    data: { recipientId: entry.recipient.id, fieldId: entry.field.id, typedSignature: entry.recipient.name },
  });
  await tx.recipient.update({
    where: { id: entry.recipient.id },
    data: { signingStatus: 'SIGNED', signedAt: new Date() },
  });
};

const staleSnapshotScenario = async (database: PrismaClient, owner: Team, services: Services) => {
  const envelope = await createEnvelope(database, owner, new Date(Date.now() + 86400000));
  for (const entry of envelope.recipients.slice(0, 2)) {
    await database.$transaction((tx) => signNatively(tx, entry));
  }
  // A third signature holds the envelope lock and commits while the partial seal is waiting for it.
  const signing = database.$transaction(
    async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public."Envelope" WHERE id=${envelope.envelopeId} FOR UPDATE`);
      await signNatively(tx, envelope.recipients[2]);
      await sleep(1500);
    },
    { timeout: 10000 },
  );
  await sleep(300);
  const receipt = await services.partialSeal.create(owner.actor, envelope.envelopeId, {
    rodada: 1,
    chaveOperacao: randomUUID(),
  });
  await signing;
  check(
    receipt.assinados === 3,
    `partial seal sees the signature committed while it waited (got ${receipt.assinados})`,
  );
};

const concurrentRoundScenario = async (database: PrismaClient, owner: Team, services: Services) => {
  const envelope = await createEnvelope(database, owner, new Date(Date.now() + 86400000));
  for (const entry of envelope.recipients.slice(0, 2)) {
    await database.$transaction((tx) => signNatively(tx, entry));
  }
  const body = { rodada: 1, chaveOperacao: randomUUID() };
  const [first, second] = await Promise.all([
    services.partialSeal.create(owner.actor, envelope.envelopeId, body),
    services.partialSeal.create(owner.actor, envelope.envelopeId, body),
  ]);
  check(JSON.stringify(first) === JSON.stringify(second), 'concurrent first calls of a round return one receipt');
  const rows = await database.$queryRaw<{ count: bigint }[]>(
    Prisma.sql`SELECT count(*) FROM semog_bridge.partial_seals WHERE "envelopeId"=${envelope.envelopeId}`,
  );
  check(Number(rows[0].count) === 1, 'one partial_seals row for the round');
  const native = await database.envelope.findUniqueOrThrow({
    where: { id: envelope.envelopeId },
    include: { envelopeItems: { include: { documentData: true } } },
  });
  check(native.status === 'PENDING' && native.completedAt === null, 'envelope stays PENDING');
  check(
    native.envelopeItems[0].documentData.data === native.envelopeItems[0].documentData.initialData,
    'envelope item keeps its original document',
  );
  const outbox = await database.$queryRaw<{ count: bigint }[]>(
    Prisma.sql`SELECT count(*) FROM semog_bridge.outbox WHERE "envelopeId"=${envelope.envelopeId}`,
  );
  check(Number(outbox[0].count) === 0, 'no outbox effect');
};

const createServices = async (database: PrismaClient, actor: Team['actor']) => {
  const signer = await P12Signer.create(await readFile(resolve(workspace, 'apps/remix/example/cert.p12')), '', {
    buildChain: false,
  });
  const font = await readFile(resolve(workspace, 'apps/remix/public/fonts/noto-sans.ttf'));
  const getDocumentI18n = async (language: string) => setupI18n({ locale: language, messages: { [language]: {} } });
  const readPdf = createSemogPdfReader();
  const partialSeal = createSemogPartialSealService({
    enabled: true,
    client: database,
    readPdf,
    signer,
    stampFont: font,
    getDocumentI18n,
    authenticate: async () => actor,
  });
  return { signer, font, getDocumentI18n, readPdf, partialSeal };
};
type Services = Awaited<ReturnType<typeof createServices>>;

let client: PrismaClient | undefined;
try {
  await startDatabase();
  client = new PrismaClient({ datasources: { db: { url: `postgresql://postgres@127.0.0.1:${port}/postgres` } } });
  const owner = await createTeam(client);
  // Native renderers read fonts and the logo from the remix app directory.
  process.chdir(resolve(workspace, 'apps/remix'));
  const services = await createServices(client, owner.actor);
  await staleSnapshotScenario(client, owner, services);
  await concurrentRoundScenario(client, owner, services);
} finally {
  process.chdir(workspace);
  await client?.$disconnect();
  await run(join(pgBin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', 'stop']).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
