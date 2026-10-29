import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { P12Signer, PDF } from '@libpdf/core';
import { setupI18n } from '@lingui/core';
import type { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { createSemogPdfReader } from './initial-pdf';
import { createSemogPartialSealService } from './partial-seal-service';

export const SEMOG_REPOSITORY_ROOT = resolve(__dirname, '../../../..');
export const SEMOG_PARTIAL_SEAL_NOW = new Date('2026-10-30T01:30:00.000Z');
export const SEMOG_PARTIAL_SEAL_KEY = '7d1c2a0e-58a4-4bd4-9a46-0f5b8d8e3c11';

type PartialSealRow = {
  chaveOperacao: string;
  teamId: number;
  envelopeId: string;
  rodada: number;
  documentDataId: string;
  hashPdf: string;
  assinantes: unknown;
  criadoEm: string;
};
type FixtureRecipient = { id: number; name: string; email: string; signed: boolean };
const people: FixtureRecipient[] = [
  { id: 1, name: 'Ana Conselheira', email: 'ana@example.org', signed: true },
  { id: 2, name: 'Bruno Conselheiro', email: 'bruno@example.org', signed: true },
  { id: 3, name: 'Carla Conselheira', email: 'carla@example.org', signed: false },
  { id: 4, name: 'Diego Conselheiro', email: 'diego@example.org', signed: false },
  { id: 5, name: 'Elisa Conselheira', email: 'elisa@example.org', signed: false },
];
const created = new Date('2026-10-20T12:00:00.000Z');

/** Two real pages from the repository assets: example.pdf followed by the blank A4 page. */
export const buildSemogTestPdf = async () => {
  const pdf = await PDF.load(readFileSync(resolve(SEMOG_REPOSITORY_ROOT, 'assets/example.pdf')));
  const blank = await PDF.load(readFileSync(resolve(SEMOG_REPOSITORY_ROOT, 'assets/a4-size.pdf')));
  await pdf.copyPagesFrom(blank, [0]);
  return await pdf.save();
};

const buildRecipient = (person: FixtureRecipient) => ({
  id: person.id,
  envelopeId: 'env_partial',
  email: person.email,
  name: person.name,
  token: `token-${person.id}`,
  role: 'SIGNER' as const,
  signingStatus: person.signed ? ('SIGNED' as const) : ('NOT_SIGNED' as const),
  readStatus: 'OPENED' as const,
  sendStatus: 'SENT' as const,
  signingOrder: null,
  signedAt: person.signed ? new Date('2026-10-25T13:00:00.000Z') : null,
  expiresAt: new Date('2026-10-30T02:59:59.000Z'),
  expirationNotifiedAt: null,
  documentDeletedAt: null,
  authOptions: null,
  rejectionReason: null,
  sentAt: created,
  lastReminderSentAt: null,
  nextReminderAt: null,
  reminderCount: 0,
});
const field = (person: FixtureRecipient, index: number, type: 'SIGNATURE' | 'TEXT') => ({
  id: person.id * 10 + (type === 'SIGNATURE' ? 1 : 2),
  secondaryId: `field${person.id}${type === 'SIGNATURE' ? 'sig' : 'txt'}`,
  envelopeId: 'env_partial',
  envelopeItemId: 'item_partial',
  recipientId: person.id,
  type,
  page: 1,
  positionX: type === 'SIGNATURE' ? 8 : 55,
  positionY: 10 + index * 16,
  width: 30,
  height: 8,
  // Non-signers keep a sentinel value that must never reach the sealed PDF.
  customText: type === 'TEXT' ? (person.signed ? `VALOR-${person.id}` : `NAO-ASSINOU-${person.id}`) : '',
  inserted: person.signed,
  fieldMeta: type === 'SIGNATURE' ? { type: 'signature' } : { type: 'text', text: '' },
  signature:
    type === 'SIGNATURE' && person.signed
      ? {
          id: person.id,
          fieldId: person.id * 10 + 1,
          recipientId: person.id,
          created,
          signatureImageAsBase64: null,
          typedSignature: person.name,
        }
      : null,
});

export const buildSemogPartialEnvelope = (initialData: string) => ({
  id: 'env_partial',
  secondaryId: 'document_77',
  externalId: null,
  type: 'DOCUMENT' as const,
  userId: 9,
  teamId: 1,
  title: 'Prestação de contas — setembro',
  status: 'PENDING' as const,
  source: 'DOCUMENT' as const,
  qrToken: 'qr-must-not-render',
  internalVersion: 2,
  useLegacyFieldInsertion: false,
  signatureLevel: 'SES' as const,
  authOptions: null,
  formValues: null,
  visibility: 'EVERYONE' as const,
  templateType: 'PRIVATE' as const,
  publicTitle: '',
  publicDescription: '',
  templateId: null,
  folderId: null,
  documentMetaId: 'meta_partial',
  createdAt: created,
  updatedAt: created,
  completedAt: null,
  deletedAt: null,
  documentMeta: {
    id: 'meta_partial',
    language: 'pt-BR',
    timezone: 'America/Recife',
    signingOrder: 'PARALLEL' as const,
  },
  user: { name: 'Semog Administração', email: 'admin@example.org' },
  recipients: people.map(buildRecipient),
  fields: people.flatMap((person, index) => [field(person, index, 'SIGNATURE'), field(person, index, 'TEXT')]),
  envelopeItems: [
    {
      id: 'item_partial',
      envelopeId: 'env_partial',
      title: 'prestacao.pdf',
      order: 0,
      documentDataId: 'data_original',
      documentData: { id: 'data_original', type: 'BYTES_64' as const, data: initialData, initialData },
    },
  ],
});
type FixtureEnvelope = ReturnType<typeof buildSemogPartialEnvelope>;

const completedLog = (person: FixtureRecipient) => ({
  id: `log-${person.id}`,
  envelopeId: 'env_partial',
  createdAt: new Date('2026-10-25T13:00:00.000Z'),
  type: 'DOCUMENT_RECIPIENT_COMPLETED',
  name: person.name,
  email: person.email,
  userId: null,
  userAgent: null,
  ipAddress: '203.0.113.7',
  data: {
    recipientEmail: person.email,
    recipientName: person.name,
    recipientId: person.id,
    recipientRole: 'SIGNER',
    actionAuth: [],
  },
});

const sqlText = (query: Prisma.Sql | TemplateStringsArray) =>
  'sql' in query && typeof query.sql === 'string' ? query.sql : Array.from(query as TemplateStringsArray).join('?');
const sqlValues = (query: Prisma.Sql | TemplateStringsArray, values: unknown[]) =>
  'values' in query && Array.isArray(query.values) ? query.values : values;

const forbiddenMutation = (name: string) =>
  vi.fn(() => {
    throw new Error(`forbidden native mutation: ${name}`);
  });

/** In-memory Prisma transaction: only the reads and inserts the partial seal is allowed to perform. */
export const createSemogPartialSealStore = (envelope: FixtureEnvelope) => {
  const state = {
    managed: true,
    partialSeals: [] as PartialSealRow[],
    documentData: new Map<string, { id: string; type: 'BYTES_64'; data: string; initialData: string }>(),
    executed: [] as string[],
  };
  const answer = (query: Prisma.Sql | TemplateStringsArray, rest: unknown[]) => {
    const text = sqlText(query);
    const values = sqlValues(query, rest);
    if (text.includes('FROM public."Envelope"') && text.includes('FOR UPDATE')) {
      return values[0] === envelope.id && values[1] === envelope.teamId ? [{ id: envelope.id }] : [];
    }
    if (text.includes('semog_bridge.activation_receipts')) {
      return [{ managed: state.managed && values[0] === envelope.id && values[1] === envelope.teamId }];
    }
    if (text.includes('FROM semog_bridge.partial_seals')) {
      return state.partialSeals.filter((row) =>
        text.includes('"chaveOperacao"')
          ? (row.envelopeId === values[0] && row.rodada === values[1]) || row.chaveOperacao === values[2]
          : row.envelopeId === values[0] && row.rodada === values[1] && row.teamId === values[2],
      );
    }
    if (text.includes('semog_bridge.operations')) {
      return [];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  const queryRaw = vi.fn((query: Prisma.Sql | TemplateStringsArray, ...rest: unknown[]) =>
    Promise.resolve().then(() => answer(query, rest)),
  );
  const insert = (query: Prisma.Sql) => {
    const text = sqlText(query);
    state.executed.push(text);
    if (!text.includes('INSERT INTO semog_bridge.partial_seals')) {
      throw new Error(`unexpected statement: ${text}`);
    }
    const [chaveOperacao, teamId, envelopeId, rodada, documentDataId, hashPdf, assinantes] = query.values;
    if (state.partialSeals.some((row) => row.envelopeId === envelopeId && row.rodada === rodada)) {
      throw new Error('unique violation');
    }
    state.partialSeals.push({
      chaveOperacao: String(chaveOperacao),
      teamId: Number(teamId),
      envelopeId: String(envelopeId),
      rodada: Number(rodada),
      documentDataId: String(documentDataId),
      hashPdf: String(hashPdf),
      assinantes: JSON.parse(String(assinantes)),
      criadoEm: '2026-10-30T01:30:00.123Z',
    });
    return 1;
  };
  const executeRaw = vi.fn((query: Prisma.Sql) => Promise.resolve().then(() => insert(query)));
  const createData = vi.fn(({ data }: { data: { type: 'BYTES_64'; data: string; initialData: string } }) => {
    const row = { id: `data_partial_${state.documentData.size + 1}`, ...data };
    state.documentData.set(row.id, row);
    return Promise.resolve(row);
  });
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    envelope: {
      findUniqueOrThrow: vi.fn(async () => envelope),
      update: forbiddenMutation('envelope.update'),
      updateMany: forbiddenMutation('envelope.updateMany'),
    },
    envelopeItem: { update: forbiddenMutation('envelopeItem.update') },
    recipient: { update: forbiddenMutation('recipient.update'), updateMany: forbiddenMutation('recipient.updateMany') },
    field: { update: forbiddenMutation('field.update') },
    documentAuditLog: {
      create: forbiddenMutation('documentAuditLog.create'),
      findMany: vi.fn(async () => people.filter((person) => person.signed).map(completedLog)),
    },
    organisationClaim: { findFirst: vi.fn(async () => ({ flags: {} })) },
    documentData: {
      create: createData,
      findUniqueOrThrow: vi.fn(({ where }: { where: { id: string } }) => {
        const row = state.documentData.get(where.id);
        return row ? Promise.resolve(row) : Promise.reject(new Error('document data not found'));
      }),
    },
  };
  const transactions: unknown[] = [];
  const client = {
    $transaction: async <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: unknown) => {
      transactions.push(options);
      // The fake implements exactly the subset of the client the partial seal may touch.
      return await fn(tx as unknown as Prisma.TransactionClient);
    },
  };
  return { state, tx, client, transactions };
};

export const createSemogPartialSealFixture = async (options: { enabled?: boolean } = {}) => {
  const original = await buildSemogTestPdf();
  const envelope = buildSemogPartialEnvelope(Buffer.from(original).toString('base64'));
  const store = createSemogPartialSealStore(envelope);
  const signer = await P12Signer.create(
    readFileSync(resolve(SEMOG_REPOSITORY_ROOT, 'apps/remix/example/cert.p12')),
    '',
    {
      buildChain: false,
    },
  );
  const getDocumentI18n = vi.fn(async (language: string) =>
    setupI18n({ locale: language, messages: { [language]: {} } }),
  );
  const authenticate = vi.fn(async () => ({ teamId: 1, userId: 9 }));
  const service = createSemogPartialSealService({
    enabled: options.enabled ?? true,
    client: store.client,
    readPdf: createSemogPdfReader(),
    signer,
    stampFont: readFileSync(resolve(SEMOG_REPOSITORY_ROOT, 'apps/remix/public/fonts/noto-sans.ttf')),
    getDocumentI18n,
    authenticate,
    now: () => SEMOG_PARTIAL_SEAL_NOW,
  });
  return { original, envelope, store, service, getDocumentI18n, authenticate, actor: { teamId: 1, userId: 9 } };
};
