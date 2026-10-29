import type { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { createSemogExtensionService } from './extension-service';
import type { SemogSigningRepositoryPort } from './service';
import { createSemogSigningService } from './service';
import { serviceFixture } from './service-test-fixtures';

export const SEMOG_EXTENSION_KEY = '5b0f4f7e-9d43-4a3c-8f2e-2f1c3a9d7e10';
export const SEMOG_CURRENT_EXPIRY = '2098-01-01T02:59:59.000Z';
export const SEMOG_NEW_EXPIRY = '2099-01-01T02:59:59.000Z';

type Snapshot = { id: string; recipientId: number; expiraEm: string; revogadaEm: string | null };
type Receipt = { chaveOperacao: string; teamId: number; envelopeId: string; hash: string; resultado: unknown };

const sqlText = (query: Prisma.Sql | TemplateStringsArray) =>
  'sql' in query && typeof query.sql === 'string' ? query.sql : Array.from(query as TemplateStringsArray).join('?');
const values = (query: Prisma.Sql) => query.values;

/** Envelope in the snapshot contract shape: 10 missing, 11 signed, 12 CC, 13 missing with an operation, 14 missing. */
const buildEnvelope = () => {
  const base = serviceFixture().envelope;
  const missing = base.recipients[0];
  const recipient = (id: number, overrides: Record<string, unknown>) => ({
    ...missing,
    id,
    email: `r${id}@example.org`,
    name: `Conselheiro ${id}`,
    token: `token-${id}`,
    expiresAt: SEMOG_CURRENT_EXPIRY,
    ...overrides,
  });
  return {
    ...base,
    recipients: [
      recipient(10, {}),
      recipient(11, { signingStatus: 'SIGNED', signedAt: '2026-10-25T13:00:00.000Z' }),
      recipient(12, { role: 'CC', expiresAt: null }),
      recipient(13, {}),
      recipient(14, {}),
    ],
  };
};
type Envelope = ReturnType<typeof buildEnvelope>;

const createState = () => ({
  managed: true,
  operations: [13],
  snapshots: [
    { id: 's-10', recipientId: 10, expiraEm: '2026-10-28T02:59:59.000Z', revogadaEm: null },
    { id: 's-11', recipientId: 11, expiraEm: '2026-10-28T02:59:59.000Z', revogadaEm: null },
  ] as Snapshot[],
  receipts: [] as Receipt[],
  capability: null as string | null,
  audits: [] as unknown[],
  recipientUpdates: [] as unknown[],
});

const answerQuery = (envelope: Envelope, state: ReturnType<typeof createState>, query: Prisma.Sql) => {
  const text = sqlText(query);
  const args = values(query);
  if (text.includes('FROM public."Envelope"') && text.includes('FOR UPDATE')) {
    return args[0] === envelope.id && args[1] === envelope.teamId ? [{ id: envelope.id }] : [];
  }
  if (text.includes('semog_bridge.activation_receipts')) {
    return [{ managed: state.managed && args[0] === envelope.id && args[1] === envelope.teamId }];
  }
  if (text.includes('FROM semog_bridge.extension_receipts')) {
    return state.receipts.filter((receipt) => receipt.chaveOperacao === args[0]);
  }
  if (text.includes('FROM semog_bridge.operations')) {
    return state.operations.map((recipientId) => ({ recipientId }));
  }
  if (text.includes('FROM semog_bridge.snapshots')) {
    return state.snapshots
      .filter((snapshot) => snapshot.revogadaEm === null)
      .map((snapshot) => ({ recipientId: snapshot.recipientId, vigente: Date.parse(snapshot.expiraEm) > Date.now() }));
  }
  if (text.includes("set_config('semog_bridge.extension_key'")) {
    state.capability = String(args[0]);
    return [{ set_config: args[0] }];
  }
  throw new Error(`unexpected query: ${text}`);
};

const executeStatement = (envelope: Envelope, state: ReturnType<typeof createState>, query: Prisma.Sql) => {
  const text = sqlText(query);
  const args = values(query);
  if (text.includes('UPDATE semog_bridge.snapshots')) {
    const ids = args[1] as number[];
    const revoked = state.snapshots.filter((s) => s.revogadaEm === null && ids.includes(s.recipientId));
    for (const snapshot of revoked) {
      snapshot.revogadaEm = new Date().toISOString();
    }
    return revoked.length;
  }
  if (text.includes('INSERT INTO semog_bridge.extension_receipts')) {
    if (state.capability !== args[0]) {
      throw new Error('receipt written without the extension capability');
    }
    state.receipts.push({
      chaveOperacao: String(args[0]),
      teamId: Number(args[2]),
      envelopeId: String(args[1]),
      hash: String(args[6]),
      resultado: JSON.parse(String(args[7])),
    });
    return 1;
  }
  throw new Error(`unexpected statement: ${text} ${envelope.id}`);
};

/** In-memory transaction with the reads and writes the extension may perform. */
export const createSemogExtensionFixture = () => {
  const envelope = buildEnvelope();
  const state = createState();
  const updateMany = vi.fn(({ where, data }: { where: { id: { in: number[] } }; data: { expiresAt: Date } }) => {
    state.recipientUpdates.push({ where, data });
    if (state.capability === null || !state.receipts.some((receipt) => receipt.chaveOperacao === state.capability)) {
      throw new Error('guard: recipient update without a durable extension receipt');
    }
    const targets = envelope.recipients.filter((r) => where.id.in.includes(r.id) && r.signingStatus === 'NOT_SIGNED');
    for (const target of targets) {
      Object.assign(target, { expiresAt: data.expiresAt.toISOString() });
    }
    return Promise.resolve({ count: targets.length });
  });
  const tx = {
    $queryRaw: vi.fn((query: Prisma.Sql) => Promise.resolve().then(() => answerQuery(envelope, state, query))),
    $executeRaw: vi.fn((query: Prisma.Sql) => Promise.resolve().then(() => executeStatement(envelope, state, query))),
    // Prisma returns Date columns; the fixture keeps the contract's ISO strings for the enrollment path.
    envelope: {
      findFirstOrThrow: vi.fn(() =>
        Promise.resolve({
          ...envelope,
          recipients: envelope.recipients.map((recipient) => ({
            ...recipient,
            expiresAt: recipient.expiresAt === null ? null : new Date(recipient.expiresAt),
            signedAt: recipient.signedAt === null ? null : new Date(recipient.signedAt),
          })),
        }),
      ),
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
      // The fake implements exactly the subset of the client the extension may touch.
      return await fn(tx as unknown as Prisma.TransactionClient);
    },
  };
  const service = createSemogExtensionService({
    enabled: true,
    client,
    authenticate: async () => ({ teamId: 1, userId: 2 }),
  });
  const pdf = new TextEncoder().encode('%PDF-1.7 test');
  const repository = {
    registerSnapshot: vi.fn<SemogSigningRepositoryPort['registerSnapshot']>(async (value) => value),
    getSnapshot: vi.fn<SemogSigningRepositoryPort['getSnapshot']>(async () => null),
    getOperation: vi.fn<SemogSigningRepositoryPort['getOperation']>(async () => null),
    reserveOperation: vi.fn<SemogSigningRepositoryPort['reserveOperation']>(),
  };
  // The real enrollment path, reading this envelope as the bridge would after the extension.
  const signing = createSemogSigningService({
    enabled: true,
    repository,
    readCurrent: async () => ({ envelope: JSON.parse(JSON.stringify(envelope)), pdf }),
  });
  return { envelope, state, tx, client, transactions, service, signing, repository, actor: { teamId: 1, userId: 2 } };
};
