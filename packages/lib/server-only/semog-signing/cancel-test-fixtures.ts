import type { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { createSemogCancelService } from './cancel-service';

export const SEMOG_CANCEL_KEY = '6f1d2c3b-4a5e-4f60-8b71-9c0d1e2f3a4b';
type Receipt = { chaveOperacao: string; teamId: number; envelopeId: string; hash: string; resultado: unknown };

const createState = () => ({
  managed: true,
  envelope: { id: 'env', teamId: 1, status: 'PENDING', completedAt: null as Date | null },
  operations: [{ estado: 'concluida', snapshotLive: false }] as {
    estado: 'pendente' | 'concluida';
    snapshotLive: boolean;
  }[],
  snapshots: [21, 22, 23].map((recipientId) => ({ recipientId, revogadaEm: null as string | null })),
  receipts: [] as Receipt[],
  capability: null as string | null,
  audits: [] as unknown[],
  jobs: [] as unknown[],
});
type State = ReturnType<typeof createState>;

const answer = (state: State, query: Prisma.Sql): unknown[] => {
  const text = query.sql;
  const args = query.values;
  if (text.includes('FROM public."Envelope"') && text.includes('FOR UPDATE')) {
    return args[0] === state.envelope.id && args[1] === state.envelope.teamId ? [{ id: state.envelope.id }] : [];
  }
  if (text.includes('semog_bridge.activation_receipts')) {
    return [{ managed: state.managed && args[0] === state.envelope.id && args[1] === state.envelope.teamId }];
  }
  if (text.includes('FROM semog_bridge.cancel_receipts')) {
    return state.receipts.filter((receipt) => receipt.chaveOperacao === args[0]);
  }
  if (text.includes('FROM semog_bridge.operations') && text.includes("estado='pendente'")) {
    // Mirrors the SQL: a query without the snapshot conditions counts every pending operation, as the old one did.
    const checksSnapshot = ['s."revogadaEm" IS NULL', 's."expiraEm">clock_timestamp()', 's.id=o."snapshotId"'].every(
      (condition) => text.includes(condition),
    );
    return [
      {
        pending: state.operations.some(
          (operation) => operation.estado === 'pendente' && (operation.snapshotLive || !checksSnapshot),
        ),
      },
    ];
  }
  if (text.includes("set_config('semog_bridge.cancel_key'")) {
    state.capability = String(args[0]);
    return [{ set_config: args[0] }];
  }
  throw new Error(`unexpected query: ${text}`);
};

const execute = (state: State, query: Prisma.Sql) => {
  const text = query.sql;
  const args = query.values;
  if (text.includes('INSERT INTO semog_bridge.cancel_receipts')) {
    state.receipts.push({
      chaveOperacao: String(args[0]),
      envelopeId: String(args[1]),
      teamId: Number(args[2]),
      hash: String(args[5]),
      resultado: null,
    });
    return 1;
  }
  if (text.includes('UPDATE semog_bridge.snapshots')) {
    // The real guard would refuse the status change once nothing is live; the fake asserts the order instead.
    if (state.envelope.status !== 'CANCELLED') {
      throw new Error('snapshots revoked before the status change');
    }
    const live = state.snapshots.filter((s) => s.revogadaEm === null);
    for (const snapshot of live) {
      snapshot.revogadaEm = new Date().toISOString();
    }
    return live.length;
  }
  if (text.includes('UPDATE semog_bridge.cancel_receipts')) {
    const receipt = state.receipts.find((entry) => entry.chaveOperacao === args[1]);
    if (!receipt) {
      throw new Error('missing receipt');
    }
    receipt.resultado = JSON.parse(String(args[0]));
    return 1;
  }
  throw new Error(`unexpected statement: ${text}`);
};

/** In-memory transaction with the reads and writes the cancellation may perform. */
export const createSemogCancelFixture = () => {
  const state = createState();
  const updateMany = vi.fn(
    ({ where, data }: { where: { id: string; status: string }; data: { status: string; completedAt: Date } }) => {
      if (!state.receipts.some((receipt) => receipt.chaveOperacao === state.capability)) {
        throw new Error('guard: status change without a durable cancel receipt');
      }
      const matches = where.id === state.envelope.id && state.envelope.status === where.status;
      if (matches) {
        Object.assign(state.envelope, data);
      }
      return Promise.resolve({ count: matches ? 1 : 0 });
    },
  );
  const tx = {
    $queryRaw: vi.fn((query: Prisma.Sql) => Promise.resolve().then(() => answer(state, query))),
    $executeRaw: vi.fn((query: Prisma.Sql) => Promise.resolve().then(() => execute(state, query))),
    envelope: {
      findFirstOrThrow: vi.fn(() => Promise.resolve({ ...state.envelope, recipients: [] })),
      updateMany,
    },
    documentAuditLog: {
      create: vi.fn((input: unknown) => {
        state.audits.push(input);
        return Promise.resolve(input);
      }),
    },
    backgroundJob: {
      create: vi.fn((input: unknown) => {
        state.jobs.push(input);
        return Promise.resolve(input);
      }),
    },
  };
  const transactions: unknown[] = [];
  const client = {
    $transaction: async <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: unknown) => {
      transactions.push(options);
      // The fake implements exactly the subset of the client the cancellation may touch.
      return await fn(tx as unknown as Prisma.TransactionClient);
    },
  };
  const authenticate = vi.fn(async (token: string) => (token === 'valid' ? { teamId: 1, userId: 2 } : null));
  const service = createSemogCancelService({ enabled: true, client, authenticate });
  return { state, tx, client, transactions, service, authenticate, actor: { teamId: 1, userId: 2 } };
};
