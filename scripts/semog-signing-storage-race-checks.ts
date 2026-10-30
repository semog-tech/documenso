/**
 * The enrollment race against the storage migration, on real PostgreSQL + MinIO, with two connections: the snapshot
 * is built from a read of the inline PDF, the migration (Prisma connection) moves it to R2, and only then the
 * snapshot is registered (psql connection). register_snapshot must refuse it (40001) and write nothing; the signing
 * service, through its real repository, must read again once and enroll on the key. Run by semog-signing-storage-local.ts.
 */
import type { PrismaClient } from '@prisma/client';
import { createSemogPdfReader } from '../packages/lib/server-only/semog-signing/initial-pdf';
import { readSemogNativeEnvelope } from '../packages/lib/server-only/semog-signing/native-envelope';
import type { SemogPdfStore } from '../packages/lib/server-only/semog-signing/pdf-store';
import {
  createSemogSigningPostgresClient,
  createSemogSigningRepository,
} from '../packages/lib/server-only/semog-signing/repository';
import { createSemogSigningService } from '../packages/lib/server-only/semog-signing/service';
import { buildSemogSnapshot } from '../packages/lib/server-only/semog-signing/snapshot';
import {
  migrateSemogStorageRow,
  planSemogStorageMigration,
} from '../packages/lib/server-only/semog-signing/storage-migration';

type Actor = { teamId: number; userId: number };
type Fixture = { envelopeId: string; recipientId: number };
export type SemogEnrollmentRaceDeps = {
  client: PrismaClient;
  actor: Actor;
  store: SemogPdfStore;
  sql: (statement: string) => Promise<string>;
  /** A bridge-managed PENDING envelope with one signer, its PDF inline (BYTES_64). */
  createInline: (bytes: Uint8Array) => Promise<Fixture>;
  pdf: (label: string) => Promise<Uint8Array>;
};

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};
const EXPIRY = '2099-01-01T00:00:00.000Z';
const migrate = async (deps: SemogEnrollmentRaceDeps, envelopeId: string) => {
  const row = (await planSemogStorageMigration(deps.client)).find((candidate) => candidate.envelopeId === envelopeId);
  if (row?.eligible !== true) {
    throw new Error(`envelope da corrida deveria ser elegível: ${row?.motivo ?? 'ausente'}`);
  }
  await migrateSemogStorageRow(deps.client, deps.store, row);
};
const readCurrent = (deps: SemogEnrollmentRaceDeps) => {
  const readPdf = createSemogPdfReader(deps.store);
  return async ({ envelopeId, actor }: { envelopeId: string; actor: Actor }) => {
    const current = await readSemogNativeEnvelope(deps.client, envelopeId, actor);
    const data = current.envelope.envelopeItems[0].documentData;
    return {
      envelope: current.source,
      pdf: await readPdf({ documentDataId: data.id, type: data.type, data: data.initialData }),
    };
  };
};
const liveSnapshots = (deps: SemogEnrollmentRaceDeps, fixture: Fixture) =>
  deps.sql(`SELECT count(*) FROM semog_bridge.snapshots WHERE "envelopeId"='${fixture.envelopeId}'
    AND "recipientId"=${fixture.recipientId} AND "revogadaEm" IS NULL`);

/** Read (Base64) -> migration commits (Prisma) -> register (psql): refused, nothing written. */
const checkStaleRefused = async (deps: SemogEnrollmentRaceDeps) => {
  const bytes = await deps.pdf('corrida-recusada');
  const fixture = await deps.createInline(bytes);
  const current = await readCurrent(deps)({ envelopeId: fixture.envelopeId, actor: deps.actor });
  const stale = buildSemogSnapshot({
    ...current,
    teamId: deps.actor.teamId,
    recipientId: fixture.recipientId,
    consentimento: 'Li e concordo.',
    expiraEm: EXPIRY,
  });
  await migrate(deps, fixture.envelopeId);
  const literal = JSON.stringify(stale).replaceAll("'", "''");
  let refusal = '';
  try {
    await deps.sql(`SELECT public.semog_signing_register_snapshot('${literal}'::jsonb)`);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  assert(/semog snapshot document changed/.test(refusal), `inscrição sobre o Base64 não foi recusada: ${refusal}`);
  assert((await liveSnapshots(deps, fixture)) === '0', 'snapshot sobre o initialData antigo foi gravada');
};

/** The service's first read is overtaken by the migration; it reads again once and enrolls on the key. */
const checkServiceRetries = async (deps: SemogEnrollmentRaceDeps) => {
  const fixture = await deps.createInline(await deps.pdf('corrida-releitura'));
  const read = readCurrent(deps);
  let reads = 0;
  const repository = createSemogSigningRepository(
    createSemogSigningPostgresClient({
      query: async (text, values) => ({
        rows: await deps.client.$queryRawUnsafe<{ result: unknown }[]>(text, ...values),
      }),
    }),
  );
  const service = createSemogSigningService({
    enabled: true,
    repository,
    readCurrent: async (input) => {
      reads++;
      const current = await read(input);
      if (reads === 1) {
        await migrate(deps, fixture.envelopeId);
      }
      return current;
    },
  });
  await service.enroll(deps.actor, {
    envelopeId: fixture.envelopeId,
    recipientId: fixture.recipientId,
    consentimento: 'Li e concordo.',
    expiraEm: EXPIRY,
  });
  assert(reads === 2, `o serviço deveria reler uma vez (leituras: ${reads})`);
  const bound =
    await deps.sql(`SELECT s.conteudo->'item'->>'hashInitialData'=encode(sha256(convert_to(d."initialData",'UTF8')),'hex')
      AND d.type='S3_PATH'
    FROM semog_bridge.snapshots s JOIN public."DocumentData" d ON d.id=s.conteudo->'item'->>'documentDataId'
    WHERE s."envelopeId"='${fixture.envelopeId}' AND s."revogadaEm" IS NULL`);
  assert(bound === 't', `inscrição após a releitura não está amarrada à chave: ${bound}`);
};

export const checkSemogEnrollmentRace = async (deps: SemogEnrollmentRaceDeps) => {
  await checkStaleRefused(deps);
  await checkServiceRetries(deps);
};
