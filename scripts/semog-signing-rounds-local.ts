/**
 * Disposable PostgreSQL rehearsal of the closing rounds (partial seal and deadline extension), including the
 * guard-trigger branch and its mutants. Run it with vite-node and the lib Vitest config, which compiles the
 * Lingui macros the native renderers use (plain tsx cannot):
 *   node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-rounds-local.ts
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
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createSemogHost } from '../packages/lib/server-only/semog-signing/host';
import { createSemogPdfReader } from '../packages/lib/server-only/semog-signing/initial-pdf';
import { createSemogPartialSealService } from '../packages/lib/server-only/semog-signing/partial-seal-service';
import { readSemogRefusal } from '../packages/lib/server-only/semog-signing/route-refusal';
import { createSemogSigningRuntime } from '../packages/lib/server-only/semog-signing/runtime';

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
  // The extension pair is exercised up, down (restoring the guard verbatim) and up again.
  await sql(await readFile('db/2026-10-29-semog-extension.sql', 'utf8'));
  await sql(await readFile('db/2026-10-29-semog-extension.down.sql', 'utf8'));
  check(
    (await sql("SELECT to_regclass('semog_bridge.extension_receipts')")).trim() === '',
    'extension down removes the receipts table',
  );
  await sql(await readFile('db/2026-10-29-semog-extension.sql', 'utf8'));
  // The contact pair: up, down (restoring the extension guard verbatim) and up again.
  await sql(await readFile('db/2026-10-29-semog-contact.sql', 'utf8'));
  await sql(await readFile('db/2026-10-29-semog-contact.down.sql', 'utf8'));
  check(
    (await sql("SELECT to_regclass('semog_bridge.contact_receipts')")).trim() === '',
    'contact down removes the receipts table',
  );
  await sql(await readFile('db/2026-10-29-semog-contact.sql', 'utf8'));
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

type Runtime = ReturnType<typeof createSemogSigningRuntime>;
const enroll = async (runtime: Runtime, owner: Team, envelopeId: string, recipientId: number, expiraEm: string) =>
  await runtime.service.enroll(owner.actor, { envelopeId, recipientId, consentimento: 'Li e concordo.', expiraEm });
type Enrollment = Awaited<ReturnType<typeof enroll>>;
const sign = async (runtime: Runtime, owner: Team, envelope: Envelope, index: number, expiraEm: string) =>
  await signWith(
    runtime,
    owner,
    envelope,
    index,
    await enroll(runtime, owner, envelope.envelopeId, envelope.recipients[index].recipient.id, expiraEm),
  );
/** The Semog app's signing call: only what it kept from the enrollment answer (hashes), bound to the recipient id. */
const signWith = async (runtime: Runtime, owner: Team, envelope: Envelope, index: number, snapshot: Enrollment) => {
  const { recipient, field } = envelope.recipients[index];
  const chaveOperacao = randomUUID();
  const result = await runtime.service.reserve(owner.actor, {
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
      identificacaoId: `contato-${recipient.id}`,
      confirmadoEm: new Date().toISOString(),
      ip: null,
      userAgent: null,
    },
  });
  check(result.situacao === 'concluida', `recipient ${index + 1} signed through the bridge`);
  return chaveOperacao;
};
const rejects = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch {
    return true;
  }
  return false;
};

/** 5 signers; 2 sign; deadline passes; partial seal; extend the 3; re-enroll; they sign; native seal completes. */
const roundsScenario = async (database: PrismaClient, owner: Team, services: Services) => {
  const runtime = createSemogSigningRuntime({
    enabled: true,
    client: database,
    signer: services.signer,
    rejectionFont: services.font,
    getDocumentI18n: services.getDocumentI18n,
  });
  const firstDeadline = new Date(Date.now() + 12000).toISOString();
  const envelope = await createEnvelope(database, owner, new Date(firstDeadline));
  await sign(runtime, owner, envelope, 0, firstDeadline);
  await sign(runtime, owner, envelope, 1, firstDeadline);
  for (const index of [2, 3, 4]) {
    await enroll(runtime, owner, envelope.envelopeId, envelope.recipients[index].recipient.id, firstDeadline);
  }
  await sleep(Math.max(0, Date.parse(firstDeadline) - Date.now()) + 500);
  const missing = envelope.recipients.slice(2).map((entry) => entry.recipient.id);
  check(
    await rejects(() =>
      enroll(runtime, owner, envelope.envelopeId, missing[0], new Date(Date.now() + 86400000).toISOString()),
    ),
    'after the deadline, a new enrollment is refused before the extension',
  );
  const round1 = await runtime.partialSeal.create(owner.actor, envelope.envelopeId, {
    rodada: 1,
    chaveOperacao: randomUUID(),
  });
  check(round1.assinados === 2 && round1.total === 5, 'round 1 partial seal: 2 of 5');
  const round1Pdf = await runtime.partialSeal.pdf(owner.actor, envelope.envelopeId, 1);
  check(
    await rejects(() =>
      database.recipient.update({ where: { id: missing[0] }, data: { expiresAt: new Date(Date.now() + 86400000) } }),
    ),
    'guard still refuses a direct expiresAt change without the extension receipt',
  );
  const secondDeadline = new Date(Date.now() + 86400000).toISOString();
  const extension = { chaveOperacao: randomUUID(), recipientIds: missing, expiraEm: secondDeadline };
  const extended = await runtime.extension.create(owner.actor, envelope.envelopeId, extension);
  check(extended.snapshotsRevogados === 3, 'extension revokes the 3 expired enrollments');
  const replay = await runtime.extension.create(owner.actor, envelope.envelopeId, extension);
  check(JSON.stringify(replay) === JSON.stringify(extended), 'extension replay returns the same receipt');
  check(
    await rejects(() =>
      runtime.extension.create(owner.actor, envelope.envelopeId, { ...extension, recipientIds: missing.slice(0, 1) }),
    ),
    'reused key with a different body is refused',
  );
  check(
    await rejects(() =>
      runtime.extension.create(owner.actor, envelope.envelopeId, {
        chaveOperacao: randomUUID(),
        recipientIds: [envelope.recipients[0].recipient.id],
        expiraEm: new Date(Date.now() + 2 * 86400000).toISOString(),
      }),
    ),
    'extension of a recipient who signed is refused',
  );
  const recipients = await database.recipient.findMany({ where: { id: { in: missing } } });
  check(
    recipients.every((r) => r.expiresAt?.toISOString() === secondDeadline),
    'Recipient.expiresAt moved to the new deadline',
  );
  const audits = await database.documentAuditLog.count({
    where: { envelopeId: envelope.envelopeId, type: 'RECIPIENT_UPDATED' },
  });
  check(audits === 3, 'one RECIPIENT_UPDATED audit per extended recipient');
  const keys = [];
  for (const index of [2, 3, 4]) {
    keys.push(await sign(runtime, owner, envelope, index, secondDeadline));
  }
  const host = createSemogHost({
    enabled: true,
    client: database,
    signer: services.signer,
    rejectionFont: services.font,
    getDocumentI18n: services.getDocumentI18n,
    onError: (error) => console.error(error),
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    const native = await database.envelope.findUniqueOrThrow({ where: { id: envelope.envelopeId } });
    if (native.status === 'COMPLETED') {
      break;
    }
    await host.tick();
  }
  const final = await database.envelope.findUniqueOrThrow({
    where: { id: envelope.envelopeId },
    include: { envelopeItems: { include: { documentData: true } } },
  });
  check(final.status === 'COMPLETED' && final.completedAt !== null, 'native full seal completed the envelope');
  const finalPdf = await runtime.executor.pdf?.(owner.actor, keys[2]);
  check(
    finalPdf !== undefined && Buffer.from(finalPdf).toString('latin1').includes('/ETSI.CAdES.detached'),
    'final sealed PDF available',
  );
  const kept = await runtime.partialSeal.pdf(owner.actor, envelope.envelopeId, 1);
  check(Buffer.compare(Buffer.from(kept), Buffer.from(round1Pdf)) === 0, 'round 1 partial seal row and PDF intact');
  const down = await readFile(resolve(workspace, 'db/2026-10-29-semog-extension.down.sql'), 'utf8');
  check(await rejects(() => sql(down)), 'extension down refuses while receipts exist');
};

const EXTENSION_SQL = 'db/2026-10-29-semog-extension.sql';
const CONTACT_SQL = 'db/2026-10-29-semog-contact.sql';
const GUARD_EXPIRY = '2099-01-01T02:59:59.000Z';
type GuardFixture = { envelopeId: string; teamId: number; userId: number; open: number; other: number; signed: number };
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
/** One transaction: optional capability, optional receipt written in it, then the Recipient update. */
const guardStatement = (
  fixture: GuardFixture,
  options: { key?: string; receipt?: { key: string; ids: number[] }; recipient: number; set: string },
) => `BEGIN;
${options.key === undefined ? '' : `SELECT set_config('semog_bridge.extension_key',${literal(options.key)},true);`}
${
  options.receipt
    ? `INSERT INTO semog_bridge.extension_receipts ("chaveOperacao","envelopeId","teamId","userId","recipientIds","expiraEm",hash,resultado)
  VALUES (${literal(options.receipt.key)}::uuid,${literal(fixture.envelopeId)},${fixture.teamId},${fixture.userId},
  ARRAY[${options.receipt.ids.join(',')}]::integer[],${literal(GUARD_EXPIRY)}::timestamptz,${literal('a'.repeat(64))},'{}'::jsonb);`
    : ''
}
UPDATE public."Recipient" SET ${options.set} WHERE id=${options.recipient};
ROLLBACK;`;
const allowed = async (statement: string) => !(await rejects(() => sql(statement)));

/** Each case: does the guard let the update through? Expected values are the contract of the new branch. */
const guardCases = async (fixture: GuardFixture, oldKey: string) => {
  const key = randomUUID();
  const own = { key, receipt: { key, ids: [fixture.open, fixture.signed] } };
  const exact = `"expiresAt"='2099-01-01 02:59:59.000',"expirationNotifiedAt"=NULL`;
  return {
    'exact value, own receipt (allowed)': await allowed(
      guardStatement(fixture, { ...own, recipient: fixture.open, set: exact }),
    ),
    'off by 1 ms': await allowed(
      guardStatement(fixture, { ...own, recipient: fixture.open, set: `"expiresAt"='2099-01-01 02:59:59.001'` }),
    ),
    'recipient not in receipt': await allowed(
      guardStatement(fixture, { ...own, recipient: fixture.other, set: exact }),
    ),
    'SIGNED recipient in receipt': await allowed(
      guardStatement(fixture, { ...own, recipient: fixture.signed, set: exact }),
    ),
    'expiresAt + name': await allowed(
      guardStatement(fixture, { ...own, recipient: fixture.open, set: `${exact},name='Outro nome'` }),
    ),
    'expiresAt + signingStatus': await allowed(
      guardStatement(fixture, {
        ...own,
        recipient: fixture.open,
        set: `${exact},"signingStatus"='SIGNED',"signedAt"=now()`,
      }),
    ),
    'expiresAt to NULL': await allowed(
      guardStatement(fixture, { ...own, recipient: fixture.open, set: `"expiresAt"=NULL` }),
    ),
    'non-UUID key': await allowed(
      guardStatement(fixture, { key: 'not-a-uuid', receipt: own.receipt, recipient: fixture.open, set: exact }),
    ),
    'receipt from an earlier transaction': await allowed(
      guardStatement(fixture, { key: oldKey, recipient: fixture.open, set: exact }),
    ),
    'native: email change with a valid receipt': await allowed(
      guardStatement(fixture, { ...own, recipient: fixture.open, set: `email='outro@example.invalid'` }),
    ),
    'native: expiresAt without capability': await allowed(
      guardStatement(fixture, { recipient: fixture.open, set: exact }),
    ),
    'native: readStatus change (allowed)': await allowed(
      guardStatement(fixture, { recipient: fixture.open, set: `"readStatus"='NOT_OPENED'` }),
    ),
  };
};
type GuardCase = keyof Awaited<ReturnType<typeof guardCases>>;
const ALLOWED_CASES: GuardCase[] = ['exact value, own receipt (allowed)', 'native: readStatus change (allowed)'];

const extractBlock = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) {
    throw new Error(`block not found: ${start}`);
  }
  return text.slice(from, to + end.length);
};
const mutate = (text: string, target: string, replacement: string) => {
  if (text.split(target).length !== 2) {
    throw new Error(`mutant target not unique: ${target}`);
  }
  return text.replace(target, replacement);
};

const guardScenario = async (database: PrismaClient, owner: Team) => {
  const envelope = await createEnvelope(database, owner, new Date('2098-01-01T00:00:00Z'));
  await database.$transaction((tx) => signNatively(tx, envelope.recipients[2]));
  const [open, other, signed, armed] = [0, 1, 2, 4].map((index) => envelope.recipients[index].recipient.id);
  const fixture = {
    envelopeId: envelope.envelopeId,
    teamId: owner.team.id,
    userId: owner.user.id,
    open,
    other,
    signed,
  };
  // A live snapshot arms the guard for this envelope.
  await sql(`INSERT INTO semog_bridge.snapshots (id,"teamId","envelopeId","recipientId","hashDocumento","hashConsentimento","hashSnapshot","expiraEm",conteudo)
    VALUES (gen_random_uuid(),${owner.team.id},${literal(envelope.envelopeId)},${armed},${literal('a'.repeat(64))},${literal('a'.repeat(64))},${literal('a'.repeat(64))},now()+interval '1 day','{}'::jsonb)`);
  const oldKey = randomUUID();
  await sql(`INSERT INTO semog_bridge.extension_receipts ("chaveOperacao","envelopeId","teamId","userId","recipientIds","expiraEm",hash,resultado)
    VALUES (${literal(oldKey)}::uuid,${literal(envelope.envelopeId)},${owner.team.id},${owner.user.id},ARRAY[${open}]::integer[],${literal(GUARD_EXPIRY)}::timestamptz,${literal('a'.repeat(64))},'{}'::jsonb)`);
  const results = await guardCases(fixture, oldKey);
  for (const [name, wasAllowed] of Object.entries(results)) {
    check(wasAllowed === ALLOWED_CASES.includes(name as GuardCase), `guard: ${name}`);
  }
  const dormant = await createEnvelope(database, owner, new Date('2098-01-01T00:00:00Z'));
  check(
    await allowed(
      `UPDATE public."Recipient" SET "expiresAt"='2099-01-01 00:00:00' WHERE id=${dormant.recipients[0].recipient.id}`,
    ),
    'guard: dormant without live snapshots (native behaviour unchanged)',
  );
  await mutantScenario(fixture, oldKey);
};

/** Each mutant of the new branch must be killed by the case written for it, then the original is restored. */
const mutantScenario = async (fixture: GuardFixture, oldKey: string) => {
  const up = await readFile(resolve(workspace, EXTENSION_SQL), 'utf8');
  const allows = extractBlock(up, 'CREATE FUNCTION semog_bridge.extension_allows', '$$;').replace(
    'CREATE FUNCTION',
    'CREATE OR REPLACE FUNCTION',
  );
  // The guard in force is the latest migration's (contact), which still carries the extension branch.
  const latest = await readFile(resolve(workspace, CONTACT_SQL), 'utf8');
  const guard = extractBlock(latest, 'CREATE OR REPLACE FUNCTION semog_bridge.guard_native_mutation()', 'END $$;');
  const mutants: { name: string; guard?: string; allows?: string; killer: GuardCase }[] = [
    {
      name: 'other columns allowed with expiresAt',
      guard: mutate(
        guard,
        "AND (after-ARRAY['expiresAt','expirationNotifiedAt'])=(before-ARRAY['expiresAt','expirationNotifiedAt'])",
        '',
      ),
      killer: 'expiresAt + name',
    },
    {
      name: 'NOT_SIGNED condition dropped',
      guard: mutate(
        guard,
        "TG_OP='UPDATE' AND before->>'signingStatus'='NOT_SIGNED' AND after->>'signingStatus'='NOT_SIGNED'\n    AND (after-ARRAY['expiresAt'",
        "TG_OP='UPDATE'\n    AND (after-ARRAY['expiresAt'",
      ),
      killer: 'SIGNED recipient in receipt',
    },
    {
      name: 'extension_allows ignores the recipient',
      allows: mutate(allows, ' AND p_recipient=ANY(r."recipientIds")', ''),
      killer: 'recipient not in receipt',
    },
    {
      name: 'extension_allows ignores the instant',
      allows: mutate(allows, `(r."expiraEm" AT TIME ZONE 'UTC')=p_expires::timestamp`, 'true'),
      killer: 'off by 1 ms',
    },
    {
      name: 'extension_allows ignores the instant (NULL)',
      allows: mutate(allows, `(r."expiraEm" AT TIME ZONE 'UTC')=p_expires::timestamp`, 'true'),
      killer: 'expiresAt to NULL',
    },
    {
      name: 'extension_allows ignores the key',
      allows: mutate(allows, `r."chaveOperacao"::text=current_setting('semog_bridge.extension_key',true)`, 'true'),
      killer: 'non-UUID key',
    },
    {
      name: 'extension_allows accepts receipts of other transactions',
      allows: mutate(allows, 'r.transacao=pg_current_xact_id_if_assigned()', 'true'),
      killer: 'receipt from an earlier transaction',
    },
  ];
  for (const mutant of mutants) {
    await sql(`${mutant.guard ?? ''}\n${mutant.allows ?? ''}`);
    const results = await guardCases(fixture, oldKey);
    await sql(`${guard}\n${allows}`);
    check(results[mutant.killer], `mutant killed: ${mutant.name} (by "${mutant.killer}")`);
  }
  const restored = await guardCases(fixture, oldKey);
  check(
    Object.entries(restored).every(([name, wasAllowed]) => wasAllowed === ALLOWED_CASES.includes(name as GuardCase)),
    'guard restored after the mutants',
  );
};

// ---- Contact change -------------------------------------------------------------------------------

type ContactFixture = {
  envelopeId: string;
  teamId: number;
  userId: number;
  open: number;
  other: number;
  signed: number;
};
const CONTACT_EMAIL = 'novo.contato@example.invalid';
const contactStatement = (
  fixture: ContactFixture,
  options: {
    key?: string;
    receipt?: { key: string; recipient: number; email: string };
    recipient: number;
    set: string;
  },
) => `BEGIN;
${options.key === undefined ? '' : `SELECT set_config('semog_bridge.contact_key',${literal(options.key)},true);`}
${
  options.receipt
    ? `INSERT INTO semog_bridge.contact_receipts ("chaveOperacao","envelopeId","teamId","userId","recipientId","emailAnterior",email,hash,resultado)
  VALUES (${literal(options.receipt.key)}::uuid,${literal(fixture.envelopeId)},${fixture.teamId},${fixture.userId},
  ${options.receipt.recipient},'antigo@example.invalid',${literal(options.receipt.email)},${literal('a'.repeat(64))},'{}'::jsonb);`
    : ''
}
UPDATE public."Recipient" SET ${options.set} WHERE id=${options.recipient};
ROLLBACK;`;

const contactCases = async (fixture: ContactFixture, oldKey: string) => {
  const key = randomUUID();
  const own = (recipient: number) => ({ key, receipt: { key, recipient, email: CONTACT_EMAIL } });
  const email = `email=${literal(CONTACT_EMAIL)}`;
  return {
    'exact e-mail, own receipt (allowed)': await allowed(
      contactStatement(fixture, { ...own(fixture.open), recipient: fixture.open, set: email }),
    ),
    'e-mail + name': await allowed(
      contactStatement(fixture, { ...own(fixture.open), recipient: fixture.open, set: `${email},name='Outro'` }),
    ),
    'e-mail + expiresAt': await allowed(
      contactStatement(fixture, {
        ...own(fixture.open),
        recipient: fixture.open,
        set: `${email},"expiresAt"='2099-01-01 00:00:00'`,
      }),
    ),
    'SIGNED recipient with its own receipt': await allowed(
      contactStatement(fixture, { ...own(fixture.signed), recipient: fixture.signed, set: email }),
    ),
    'e-mail other than the receipt': await allowed(
      contactStatement(fixture, {
        ...own(fixture.open),
        recipient: fixture.open,
        set: `email='outro@example.invalid'`,
      }),
    ),
    'recipient not in receipt': await allowed(
      contactStatement(fixture, { ...own(fixture.open), recipient: fixture.other, set: email }),
    ),
    'receipt from an earlier transaction': await allowed(
      contactStatement(fixture, { key: oldKey, recipient: fixture.open, set: email }),
    ),
    'e-mail without capability': await allowed(contactStatement(fixture, { recipient: fixture.open, set: email })),
  };
};
type ContactCase = keyof Awaited<ReturnType<typeof contactCases>>;

const contactGuardScenario = async (database: PrismaClient, owner: Team) => {
  const envelope = await createEnvelope(database, owner, new Date('2098-01-01T00:00:00Z'));
  await database.$transaction((tx) => signNatively(tx, envelope.recipients[2]));
  const [open, other, signed, armed] = [0, 1, 2, 4].map((index) => envelope.recipients[index].recipient.id);
  const fixture = {
    envelopeId: envelope.envelopeId,
    teamId: owner.team.id,
    userId: owner.user.id,
    open,
    other,
    signed,
  };
  await sql(`INSERT INTO semog_bridge.snapshots (id,"teamId","envelopeId","recipientId","hashDocumento","hashConsentimento","hashSnapshot","expiraEm",conteudo)
    VALUES (gen_random_uuid(),${owner.team.id},${literal(envelope.envelopeId)},${armed},${literal('a'.repeat(64))},${literal('a'.repeat(64))},${literal('a'.repeat(64))},now()+interval '1 day','{}'::jsonb)`);
  const oldKey = randomUUID();
  await sql(`INSERT INTO semog_bridge.contact_receipts ("chaveOperacao","envelopeId","teamId","userId","recipientId","emailAnterior",email,hash,resultado)
    VALUES (${literal(oldKey)}::uuid,${literal(envelope.envelopeId)},${owner.team.id},${owner.user.id},${open},'antigo@example.invalid',${literal(CONTACT_EMAIL)},${literal('a'.repeat(64))},'{}'::jsonb)`);
  const expected = (name: string) => name === 'exact e-mail, own receipt (allowed)';
  for (const [name, wasAllowed] of Object.entries(await contactCases(fixture, oldKey))) {
    check(wasAllowed === expected(name), `contact guard: ${name}`);
  }
  const up = await readFile(resolve(workspace, CONTACT_SQL), 'utf8');
  const guard = extractBlock(up, 'CREATE OR REPLACE FUNCTION semog_bridge.guard_native_mutation()', 'END $$;');
  const allows = extractBlock(up, 'CREATE FUNCTION semog_bridge.contact_allows', '$$;').replace(
    'CREATE FUNCTION',
    'CREATE OR REPLACE FUNCTION',
  );
  const mutants: { name: string; guard?: string; allows?: string; killer: ContactCase }[] = [
    {
      name: 'other columns allowed with email',
      guard: mutate(guard, "AND (after-'email')=(before-'email')", ''),
      killer: 'e-mail + name',
    },
    {
      name: 'NOT_SIGNED condition dropped (contact)',
      guard: mutate(
        guard,
        "TG_OP='UPDATE' AND before->>'signingStatus'='NOT_SIGNED' AND after->>'signingStatus'='NOT_SIGNED'\n    AND (after-'email')",
        "TG_OP='UPDATE'\n    AND (after-'email')",
      ),
      killer: 'SIGNED recipient with its own receipt',
    },
    {
      name: 'contact_allows ignores the recipient',
      allows: mutate(allows, ' AND r."recipientId"=p_recipient', ''),
      killer: 'recipient not in receipt',
    },
    {
      name: 'contact_allows ignores the e-mail',
      allows: mutate(allows, 'r.email=p_email', 'true'),
      killer: 'e-mail other than the receipt',
    },
    {
      name: 'contact_allows accepts receipts of other transactions',
      allows: mutate(allows, 'r.transacao=pg_current_xact_id_if_assigned()', 'true'),
      killer: 'receipt from an earlier transaction',
    },
  ];
  for (const mutant of mutants) {
    await sql(`${mutant.guard ?? ''}\n${mutant.allows ?? ''}`);
    const results = await contactCases(fixture, oldKey);
    await sql(`${guard}\n${allows}`);
    check(results[mutant.killer], `contact mutant killed: ${mutant.name} (by "${mutant.killer}")`);
  }
  const restored = await contactCases(fixture, oldKey);
  check(
    Object.entries(restored).every(([name, wasAllowed]) => wasAllowed === expected(name)),
    'contact guard restored after the mutants',
  );
};

const countSideEffects = async (database: PrismaClient, envelopeId: string) => {
  const outbox = await database.$queryRaw<{ count: bigint }[]>(
    Prisma.sql`SELECT count(*) FROM semog_bridge.outbox WHERE "envelopeId"=${envelopeId}`,
  );
  return { outbox: Number(outbox[0].count), jobs: await database.backgroundJob.count() };
};
const pdfText = async (bytes: Uint8Array) => {
  const document = await getDocument({ data: new Uint8Array(bytes) }).promise;
  const texts: string[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const content = await (await document.getPage(number)).getTextContent();
    texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
  }
  await document.destroy();
  return texts.join('\n');
};
const sealWithHost = async (database: PrismaClient, services: Services, envelopeId: string) => {
  const host = createSemogHost({
    enabled: true,
    client: database,
    signer: services.signer,
    rejectionFont: services.font,
    getDocumentI18n: services.getDocumentI18n,
    onError: (error) => console.error(error),
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    if ((await database.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status === 'COMPLETED') {
      return;
    }
    await host.tick();
  }
};

/** 5 signers, 1 signs, 4 enrolled live; #2's e-mail changes; everyone signs with what the Semog app kept. */
const contactScenario = async (database: PrismaClient, owner: Team, services: Services) => {
  const runtime = createSemogSigningRuntime({
    enabled: true,
    client: database,
    signer: services.signer,
    rejectionFont: services.font,
    getDocumentI18n: services.getDocumentI18n,
  });
  const deadline = new Date(Date.now() + 86400000).toISOString();
  const envelope = await createEnvelope(database, owner, new Date(deadline));
  const ids = envelope.recipients.map((entry) => entry.recipient.id);
  await sign(runtime, owner, envelope, 0, deadline);
  const enrollments = new Map<number, Enrollment>();
  for (const index of [1, 2, 3, 4]) {
    enrollments.set(index, await enroll(runtime, owner, envelope.envelopeId, ids[index], deadline));
  }
  // Someone mid-signature (a reserved but unexecuted operation) blocks the change; nothing moves.
  const pending = randomUUID();
  await sql(`INSERT INTO semog_bridge.operations ("chaveOperacao","snapshotId","teamId","envelopeId","recipientId","hashDocumento","hashConsentimento",acao,"hashPedido",pedido,evidencias)
    SELECT ${literal(pending)}::uuid,id,"teamId","envelopeId","recipientId","hashDocumento","hashConsentimento",'assinar',${literal('a'.repeat(64))},'{}'::jsonb,'{}'::jsonb
    FROM semog_bridge.snapshots WHERE "envelopeId"=${literal(envelope.envelopeId)} AND "recipientId"=${ids[2]} AND "revogadaEm" IS NULL`);
  const blocked = await refusalDetail(() =>
    runtime.contact.create(owner.actor, envelope.envelopeId, {
      chaveOperacao: randomUUID(),
      recipientId: ids[1],
      email: CONTACT_EMAIL,
    }),
  );
  check(
    blocked === `operacao-em-andamento:${ids[2]}:operacao-existente`,
    `operation in flight refuses the change (${blocked})`,
  );
  const untouched = await database.recipient.findUniqueOrThrow({ where: { id: ids[1] } });
  const liveBefore = await sql(
    `SELECT count(*) FROM semog_bridge.snapshots WHERE "envelopeId"=${literal(envelope.envelopeId)} AND "revogadaEm" IS NULL`,
  );
  check(
    untouched.email === envelope.recipients[1].recipient.email && liveBefore.trim() === '5',
    'refusal changed nothing',
  );
  await sql(`DELETE FROM semog_bridge.operations WHERE "chaveOperacao"=${literal(pending)}::uuid`);

  const before = await countSideEffects(database, envelope.envelopeId);
  const result = await runtime.contact.create(owner.actor, envelope.envelopeId, {
    chaveOperacao: randomUUID(),
    recipientId: ids[1],
    email: '  Novo.Contato@Example.INVALID ',
  });
  check(
    JSON.stringify(result.revogados) === JSON.stringify(ids.slice(1)) &&
      JSON.stringify(result.reinscritos) === JSON.stringify(ids.slice(1)),
    'contact change revoked and re-enrolled the 4 live missing enrollments',
  );
  const changed = await database.recipient.findUniqueOrThrow({ where: { id: ids[1] } });
  check(changed.email === CONTACT_EMAIL, 'Recipient.email normalized and changed');
  const after = await countSideEffects(database, envelope.envelopeId);
  check(after.outbox === before.outbox && after.jobs === before.jobs, 'no outbox effect and no native job (no e-mail)');
  const audit = await database.documentAuditLog.findFirst({
    where: { envelopeId: envelope.envelopeId, type: 'RECIPIENT_UPDATED' },
  });
  check(
    JSON.stringify(audit?.data).includes(`"to":"${CONTACT_EMAIL}"`),
    'RECIPIENT_UPDATED audit with the e-mail change',
  );
  const keys = [];
  for (const index of [2, 3, 4, 1]) {
    const enrollment = enrollments.get(index);
    if (!enrollment) {
      throw new Error('missing enrollment');
    }
    keys.push(await signWith(runtime, owner, envelope, index, enrollment));
  }
  await sealWithHost(database, services, envelope.envelopeId);
  const final = await database.envelope.findUniqueOrThrow({ where: { id: envelope.envelopeId } });
  check(final.status === 'COMPLETED', 'native full seal completed after the contact change');
  const finalPdf = await runtime.executor.pdf?.(owner.actor, keys[3]);
  const text = finalPdf ? await pdfText(finalPdf) : '';
  check(
    text.includes(CONTACT_EMAIL) && !text.includes(envelope.recipients[1].recipient.email),
    'certificate shows the new e-mail, not the old one',
  );
};

/** Closed request: change the e-mail after the deadline, then extend and enroll again (the resend flow). */
const closedContactScenario = async (database: PrismaClient, owner: Team, services: Services) => {
  const runtime = createSemogSigningRuntime({
    enabled: true,
    client: database,
    signer: services.signer,
    rejectionFont: services.font,
    getDocumentI18n: services.getDocumentI18n,
  });
  const first = new Date(Date.now() + 10000).toISOString();
  const envelope = await createEnvelope(database, owner, new Date(first));
  const ids = envelope.recipients.map((entry) => entry.recipient.id);
  for (const index of [0, 1, 2, 3]) {
    await sign(runtime, owner, envelope, index, first);
  }
  await enroll(runtime, owner, envelope.envelopeId, ids[4], first);
  await sleep(Math.max(0, Date.parse(first) - Date.now()) + 500);
  const changed = await runtime.contact.create(owner.actor, envelope.envelopeId, {
    chaveOperacao: randomUUID(),
    recipientId: ids[4],
    email: 'fechado@example.invalid',
  });
  check(
    JSON.stringify(changed.revogados) === JSON.stringify([ids[4]]) && changed.reinscritos.length === 0,
    'after the deadline the expired enrollment is revoked, not re-enrolled',
  );
  const second = new Date(Date.now() + 86400000).toISOString();
  await runtime.extension.create(owner.actor, envelope.envelopeId, {
    chaveOperacao: randomUUID(),
    recipientIds: [ids[4]],
    expiraEm: second,
  });
  await sign(runtime, owner, envelope, 4, second);
  await sealWithHost(database, services, envelope.envelopeId);
  const final = await database.envelope.findUniqueOrThrow({ where: { id: envelope.envelopeId } });
  check(final.status === 'COMPLETED', 'contact change + extension + new enrollment complete the envelope');
  const down = await readFile(resolve(workspace, 'db/2026-10-29-semog-contact.down.sql'), 'utf8');
  check(await rejects(() => sql(down)), 'contact down refuses while receipts exist');
};

const refusalDetail = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    const refusal = readSemogRefusal(error);
    return refusal
      ? [refusal.codigo, ...(refusal.destinatarios ?? []).flatMap((entry) => [entry.recipientId, entry.motivo])].join(
          ':',
        )
      : 'other';
  }
};

const refusalCode = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    return readSemogRefusal(error)?.codigo ?? 'other';
  }
};
/** The same key on two envelopes at once: one wins, the other gets the reused-key 409 (never a 503). */
const sharedKeyScenario = async (database: PrismaClient, owner: Team, services: Services) => {
  const runtime = createSemogSigningRuntime({ enabled: true, client: database });
  const [first, second] = [
    await createEnvelope(database, owner, new Date(Date.now() + 86400000)),
    await createEnvelope(database, owner, new Date(Date.now() + 86400000)),
  ];
  const sealKey = randomUUID();
  const seals = await Promise.all(
    [first, second].map((envelope) =>
      refusalCode(() =>
        services.partialSeal.create(owner.actor, envelope.envelopeId, { rodada: 1, chaveOperacao: sealKey }),
      ),
    ),
  );
  check(seals.sort().join(',') === 'chave-reutilizada,ok', `partial seal: shared key → ${seals.join(', ')}`);
  const extensionKey = randomUUID();
  const expiraEm = new Date(Date.now() + 2 * 86400000).toISOString();
  const extensions = await Promise.all(
    [first, second].map((envelope) =>
      refusalCode(() =>
        runtime.extension.create(owner.actor, envelope.envelopeId, {
          chaveOperacao: extensionKey,
          recipientIds: [envelope.recipients[0].recipient.id],
          expiraEm,
        }),
      ),
    ),
  );
  check(extensions.sort().join(',') === 'chave-reutilizada,ok', `extension: shared key → ${extensions.join(', ')}`);
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
  await guardScenario(client, owner);
  await staleSnapshotScenario(client, owner, services);
  await concurrentRoundScenario(client, owner, services);
  await sharedKeyScenario(client, owner, services);
  await roundsScenario(client, owner, services);
  await contactGuardScenario(client, owner);
  await contactScenario(client, owner, services);
  await closedContactScenario(client, owner, services);
} finally {
  process.chdir(workspace);
  await client?.$disconnect();
  await run(join(pgBin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', 'stop']).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
