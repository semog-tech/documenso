import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { createSemogContactService } from './contact-service';
import type { SemogSigningRepositoryPort } from './service';
import { createSemogSigningService } from './service';
import { serviceFixture } from './service-test-fixtures';

export const SEMOG_CONTACT_KEY = '3c9e1b52-7a14-4e0b-9d6f-0b8a2e5f4c21';
export const SEMOG_CONSENT = 'Li e concordo.';
const pdf = new TextEncoder().encode('%PDF-1.7 test');
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const SEMOG_HASH_DOCUMENT = sha256(pdf);
export const SEMOG_HASH_CONSENT = sha256(SEMOG_CONSENT);

type Snapshot = {
  id: string;
  recipientId: number;
  expiraEm: string;
  revogadaEm: string | null;
  hashDocumento: string;
  hashConsentimento: string;
  hashSnapshot: string;
  conteudo: Record<string, unknown>;
};
type Receipt = { chaveOperacao: string; teamId: number; envelopeId: string; hash: string; resultado: unknown };

const sqlText = (query: Prisma.Sql) => query.sql;

/**
 * Contract-shaped envelope: 20 signed, 21 target, 22 and 23 missing, 24 CC, 25 missing without enrollment.
 * Every signer has its own SIGNATURE field, so each missing one can be enrolled again.
 */
const buildEnvelope = () => {
  const base = serviceFixture().envelope;
  const template = base.recipients[0];
  const field = base.fields[0];
  const recipient = (id: number, overrides: Record<string, unknown> = {}) => ({
    ...template,
    id,
    email: `r${id}@example.org`,
    name: `Conselheiro ${id}`,
    token: `token-${id}`,
    expiresAt: '2098-06-01T02:59:59.000Z',
    ...overrides,
  });
  const recipients = [
    recipient(20, { signingStatus: 'SIGNED', signedAt: '2026-10-25T13:00:00.000Z' }),
    recipient(21),
    recipient(22),
    recipient(23),
    recipient(24, { role: 'CC', expiresAt: null }),
    recipient(25),
  ];
  const fields = recipients
    .filter((entry) => entry.role === 'SIGNER')
    .map((entry) => ({
      ...field,
      id: entry.id * 10,
      recipientId: entry.id,
      inserted: entry.signingStatus === 'SIGNED',
    }));
  return { ...base, recipients, fields };
};
type Envelope = ReturnType<typeof buildEnvelope>;

const liveSnapshot = (recipientId: number, expiraEm: string): Snapshot => ({
  id: `00000000-0000-4000-8000-0000000000${recipientId}`,
  recipientId,
  expiraEm,
  revogadaEm: null,
  hashDocumento: SEMOG_HASH_DOCUMENT,
  hashConsentimento: SEMOG_HASH_CONSENT,
  hashSnapshot: 'f'.repeat(64),
  conteudo: { consentimento: SEMOG_CONSENT },
});
const createState = () => ({
  managed: true,
  operations: [{ recipientId: 20 }] as { recipientId: number }[],
  snapshots: [
    liveSnapshot(20, '2098-01-01T00:00:00.000Z'),
    liveSnapshot(21, '2098-01-01T00:00:00.000Z'),
    liveSnapshot(22, '2098-01-01T00:00:00.000Z'),
    liveSnapshot(23, '2026-10-01T00:00:00.000Z'),
  ],
  receipts: [] as Receipt[],
  capability: null as string | null,
  audits: [] as unknown[],
  registered: [] as Snapshot[],
});
type State = ReturnType<typeof createState>;

const answer = (envelope: Envelope, state: State, query: Prisma.Sql): unknown[] => {
  const text = sqlText(query);
  const args = query.values;
  if (text.includes('FROM public."Envelope"') && text.includes('FOR UPDATE')) {
    return args[0] === envelope.id && args[1] === envelope.teamId ? [{ id: envelope.id }] : [];
  }
  if (text.includes('semog_bridge.activation_receipts')) {
    return [{ managed: state.managed && args[0] === envelope.id && args[1] === envelope.teamId }];
  }
  if (text.includes('FROM semog_bridge.contact_receipts')) {
    return state.receipts.filter((receipt) => receipt.chaveOperacao === args[0]);
  }
  if (text.includes('FROM semog_bridge.operations')) {
    return state.operations;
  }
  if (text.includes("set_config('semog_bridge.contact_key'")) {
    state.capability = String(args[0]);
    return [{ set_config: args[0] }];
  }
  if (text.includes('UPDATE semog_bridge.snapshots')) {
    const ids = args[1] as number[];
    const revoked = state.snapshots.filter((s) => s.revogadaEm === null && ids.includes(s.recipientId));
    for (const snapshot of revoked) {
      snapshot.revogadaEm = new Date().toISOString();
    }
    return revoked.map((snapshot) => ({
      recipientId: snapshot.recipientId,
      expiraEm: new Date(snapshot.expiraEm),
      consentimento: snapshot.conteudo.consentimento,
      vigente: Date.parse(snapshot.expiraEm) > Date.now(),
    }));
  }
  if (text.includes('semog_signing_register_snapshot')) {
    const snapshot: Snapshot = { ...JSON.parse(String(args[0])), revogadaEm: null };
    if (state.snapshots.some((s) => s.recipientId === snapshot.recipientId && s.revogadaEm === null)) {
      throw new Error('snapshot conflict');
    }
    state.snapshots.push(snapshot);
    state.registered.push(snapshot);
    return [{ result: snapshot }];
  }
  throw new Error(`unexpected query: ${text}`);
};

const insertReceipt = (state: State, query: Prisma.Sql) => {
  const text = sqlText(query);
  const args = query.values;
  if (!text.includes('INSERT INTO semog_bridge.contact_receipts') || state.capability !== args[0]) {
    throw new Error(`unexpected statement or missing capability: ${text}`);
  }
  state.receipts.push({
    chaveOperacao: String(args[0]),
    envelopeId: String(args[1]),
    teamId: Number(args[2]),
    hash: String(args[7]),
    resultado: JSON.parse(String(args[8])),
  });
  return 1;
};

const prismaShaped = (envelope: Envelope) => ({
  ...envelope,
  recipients: envelope.recipients.map((recipient) => ({
    ...recipient,
    expiresAt: recipient.expiresAt === null ? null : new Date(recipient.expiresAt),
    signedAt: recipient.signedAt === null ? null : new Date(recipient.signedAt),
  })),
});

/** In-memory transaction with the reads and writes the contact change may perform. */
export const createSemogContactFixture = () => {
  const envelope = buildEnvelope();
  const state = createState();
  const updateMany = vi.fn(({ where, data }: { where: { id: number }; data: { email: string } }) => {
    if (!state.receipts.some((receipt) => receipt.chaveOperacao === state.capability)) {
      throw new Error('guard: email change without a durable contact receipt');
    }
    const target = envelope.recipients.find((r) => r.id === where.id && r.signingStatus === 'NOT_SIGNED');
    if (target) {
      target.email = data.email;
    }
    return Promise.resolve({ count: target ? 1 : 0 });
  });
  const tx = {
    $queryRaw: vi.fn((query: Prisma.Sql) => Promise.resolve().then(() => answer(envelope, state, query))),
    $executeRaw: vi.fn((query: Prisma.Sql) => Promise.resolve().then(() => insertReceipt(state, query))),
    envelope: {
      findFirstOrThrow: vi.fn(() => Promise.resolve(prismaShaped(envelope))),
      // readSemogNativeEnvelope serializes through JSON; the contract-shaped fixture is already that shape.
      findFirst: vi.fn(() => Promise.resolve(JSON.parse(JSON.stringify(envelope)))),
    },
    recipient: { updateMany },
    documentAuditLog: {
      create: vi.fn((input: unknown) => {
        state.audits.push(input);
        return Promise.resolve(input);
      }),
    },
  };
  const transactions: unknown[] = [];
  const client = {
    $transaction: async <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: unknown) => {
      transactions.push(options);
      // The fake implements exactly the subset of the client the contact change may touch.
      return await fn(tx as unknown as Prisma.TransactionClient);
    },
  };
  const service = createSemogContactService({
    enabled: true,
    client,
    readPdf: async () => pdf,
    authenticate: async () => ({ teamId: 1, userId: 2 }),
  });
  return { envelope, state, tx, client, transactions, service, pdf, actor: { teamId: 1, userId: 2 } };
};

/** The unchanged signing service, reading the registered snapshot exactly as /manifestacoes would. */
export const createSemogSigningAfterContact = (fixture: ReturnType<typeof createSemogContactFixture>) => {
  const repository = {
    registerSnapshot: vi.fn<SemogSigningRepositoryPort['registerSnapshot']>(async (value) => value),
    getSnapshot: vi.fn<SemogSigningRepositoryPort['getSnapshot']>(({ recipientId }) => {
      const snapshot = fixture.state.snapshots.find((s) => s.recipientId === recipientId && s.revogadaEm === null);
      return Promise.resolve(snapshot ? { ...snapshot, teamId: 1, envelopeId: 'env' } : null);
    }),
    getOperation: vi.fn<SemogSigningRepositoryPort['getOperation']>(async () => null),
    reserveOperation: vi.fn<SemogSigningRepositoryPort['reserveOperation']>(async (value) => ({
      ...value,
      criadaEm: '2026-10-29T12:00:00.000Z',
      estado: 'pendente' as const,
    })),
  };
  const service = createSemogSigningService({
    enabled: true,
    repository,
    readCurrent: async () => ({ envelope: JSON.parse(JSON.stringify(fixture.envelope)), pdf: fixture.pdf }),
  });
  return { service, repository };
};
