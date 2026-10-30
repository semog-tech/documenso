import { createHash } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import type { SemogPrismaTransactionRunner } from './execution';
import { createSemogPrismaExecutor } from './execution';
import { createSemogPdfReader } from './initial-pdf';
import type { SemogPdfStore } from './pdf-store';
import { semogPdfKeyFor } from './pdf-store';
import type { SemogSigningRepositoryPort } from './service';
import { createSemogSigningService } from './service';
import { serviceFixture } from './service-test-fixtures';
import { buildSemogSnapshot } from './snapshot';
import type { SemogStageObserver } from './timing';

type Operation = Awaited<ReturnType<SemogSigningRepositoryPort['reserveOperation']>> & {
  resultado: unknown;
  execucao: unknown;
};
type DocumentArgs = { include?: { envelopeItems?: { include?: { documentData?: { select?: object } } } } };
type Storage = 'BYTES_64' | 'S3_PATH';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const pdfWithPages = async (pages: number) => {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page++) {
    document.addPage([600, 800]);
  }
  return await document.save();
};
/** A parseable PDF carrying the two markers observedResult requires of a sealed file. */
export const sealedLikePdf = async () =>
  new Uint8Array([...(await pdfWithPages(2)), ...Buffer.from('\n%/ByteRange /ETSI.CAdES.detached\n')]);
const strict = <T extends object>(name: string, target: T) =>
  new Proxy(target, {
    get: (object, property) => {
      if (typeof property === 'symbol' || property === 'then' || Reflect.has(object, property)) {
        return Reflect.get(object, property);
      }
      throw new Error(`Dublê ${name}: acesso não previsto a ${property}`);
    },
  });

const createState = async (options: { fieldPage?: number; storage?: Storage }) => {
  const base = serviceFixture();
  const pdf = await pdfWithPages(1);
  const storage = options.storage ?? 'BYTES_64';
  const objects = new Map<string, Uint8Array>();
  const initialData = storage === 'S3_PATH' ? semogPdfKeyFor(sha256(pdf)) : Buffer.from(pdf).toString('base64');
  objects.set(initialData, pdf);
  return {
    base,
    pdf,
    objects,
    state: {
      // `data` deliberately differs from INITIAL_DATA: a digest query on the wrong column then fails the binding.
      documentData: { id: 'data', type: storage, initialData, data: `coluna-data-distinta:${initialData.length}` },
      envelope: {
        ...base.envelope,
        status: 'PENDING',
        secondaryId: 'document_1',
        userId: 3,
        fields: base.envelope.fields.map((field) => ({
          ...field,
          page: options.fieldPage ?? field.page,
          secondaryId: `field-${field.id}`,
        })),
      },
      operation: null as Operation | null,
      snapshotActive: true,
      inSerializable: false,
      serializableRuns: 0,
      writes: 0,
      beforeSerializable: undefined as (() => void) | undefined,
      pdfBudget: 1,
      pdfReads: 0,
      storeReadFailure: null as Error | null,
    },
  };
};
type State = Awaited<ReturnType<typeof createState>>['state'];

/** Answers a digest query from the column the SQL actually names, never from what the caller hoped to read. */
const digestOf = (state: State, text: string) => {
  const column = (name: string) => text.includes(`convert_to(${name},'UTF8')`);
  if (text.includes(') hash FROM')) {
    if (!column('"initialData"') || column('data')) {
      throw new Error(`Dublê tx: digest do INITIAL_DATA sobre a coluna errada: ${text}`);
    }
    return [{ hash: sha256(state.documentData.initialData) }];
  }
  return [{ initial: sha256(state.documentData.initialData), data: sha256(state.documentData.data) }];
};
const answerOperation = (state: State, text: string, statement: Prisma.Sql) => {
  const operation = state.operation;
  if (text.includes('SELECT "envelopeId", estado, execucao')) {
    return operation
      ? [{ envelopeId: operation.envelopeId, estado: operation.estado, execucao: operation.execucao }]
      : [];
  }
  if (text.includes('SELECT "envelopeId", estado')) {
    return operation ? [{ envelopeId: operation.envelopeId, estado: operation.estado }] : [];
  }
  if (text.includes('SELECT "envelopeId" FROM semog_bridge.operations')) {
    return operation ? [{ envelopeId: operation.envelopeId }] : [];
  }
  if (text.includes('to_jsonb(o)')) {
    return operation ? [{ body: structuredClone(operation) }] : [];
  }
  if (text.includes('semog_signing_finish_operation') && operation) {
    operation.estado = 'concluida';
    operation.resultado = JSON.parse(String(statement.values[2]));
    return [];
  }
  return null;
};

/**
 * In-memory stand-in for the slice of Prisma and object storage the executor touches. Strict on purpose: an
 * unexpected delegate, a PDF read over budget, any PDF or object read inside the Serializable transaction, or
 * INITIAL_DATA selected there all throw.
 */
export const executionFixture = async (
  options: { fieldPage?: number; observe?: SemogStageObserver; storage?: Storage } = {},
) => {
  const { base, pdf, objects, state } = await createState(options);
  const source = () => ({
    ...state.envelope,
    envelopeItems: [{ ...state.envelope.envelopeItems[0], documentData: { ...state.documentData } }],
  });
  const snapshot = buildSemogSnapshot({ ...base.enrollment, envelope: source(), pdf, teamId: 1 });
  const store: SemogPdfStore = {
    read: (key) => {
      if (state.inSerializable) {
        return Promise.reject(new Error('Objeto lido dentro da transação Serializable'));
      }
      const bytes = objects.get(key);
      return state.storeReadFailure
        ? Promise.reject(state.storeReadFailure)
        : bytes
          ? Promise.resolve(bytes)
          : Promise.reject(new Error(`Dublê store: objeto ausente ${key}`));
    },
    write: (key, bytes) => {
      objects.set(key, bytes);
      return Promise.resolve();
    },
  };
  const decode = createSemogPdfReader(store);
  const readPdf = vi.fn(async (input: Parameters<typeof decode>[0]) => {
    if (state.inSerializable) {
      throw new Error('PDF lido dentro da transação Serializable');
    }
    state.pdfReads++;
    if (state.pdfReads > state.pdfBudget) {
      throw new Error('PDF lido mais vezes que o orçamento da manifestação');
    }
    return await decode(input);
  });
  const findEnvelope = (args: DocumentArgs & { where: { status?: string } }) => {
    const select = args.include?.envelopeItems?.include?.documentData?.select ?? {};
    if (state.inSerializable && ('initialData' in select || 'data' in select)) {
      throw new Error('Coluna do PDF lida dentro da transação Serializable');
    }
    if (args.where.status !== undefined && args.where.status !== state.envelope.status) {
      return null;
    }
    const { initialData, data, ...withoutBytes } = state.documentData;
    const documentData = {
      ...withoutBytes,
      ...('initialData' in select ? { initialData } : {}),
      ...('data' in select ? { data } : {}),
    };
    return structuredClone({ ...source(), envelopeItems: [{ ...state.envelope.envelopeItems[0], documentData }] });
  };
  const answer = (statement: Prisma.Sql) => {
    const text = statement.sql;
    const operation = answerOperation(state, text, statement);
    if (operation !== null) {
      return operation;
    }
    if (text.includes('public."Envelope"')) {
      return [{ id: state.envelope.id }];
    }
    if (text.includes('semog_bridge.snapshots')) {
      return [{ body: { ...snapshot, revogadaEm: null }, active: state.snapshotActive }];
    }
    if (text.includes('sha256(convert_to')) {
      return digestOf(state, text);
    }
    if (text.includes('set_config')) {
      return [];
    }
    throw new Error(`Dublê tx: consulta não prevista ${text}`);
  };
  const write = <T>(value: T) => {
    state.writes++;
    return Promise.resolve(value);
  };
  const tx = strict('tx', {
    $queryRaw: (statement: Prisma.Sql) => Promise.resolve(answer(statement)),
    $executeRaw: () => write(1),
    envelope: strict('envelope', {
      findFirst: async (args: DocumentArgs & { where: { status?: string } }) => findEnvelope(args),
    }),
    recipient: strict('recipient', {
      findMany: async () => [],
      updateMany: () => write({ count: 1 }),
      update: () => write({}),
    }),
    field: strict('field', { updateMany: () => write({ count: 1 }) }),
    signature: strict('signature', { upsert: () => write({}) }),
    documentAuditLog: strict('documentAuditLog', { create: () => write({ id: `audit-${state.writes}` }) }),
  });
  const client: SemogPrismaTransactionRunner = {
    $transaction: async (fn, transaction) => {
      const serializable = transaction?.isolationLevel === 'Serializable';
      if (serializable) {
        state.serializableRuns++;
        state.beforeSerializable?.();
        state.inSerializable = true;
      }
      try {
        // The strict Proxy implements only what the executor calls; anything else throws instead of passing.
        return await fn(tx as unknown as Prisma.TransactionClient);
      } finally {
        state.inSerializable = false;
      }
    },
  };
  const repository: SemogSigningRepositoryPort = {
    registerSnapshot: async (value) => value,
    getSnapshot: async () => snapshot,
    getOperation: async ({ chaveOperacao }) =>
      state.operation?.chaveOperacao === chaveOperacao ? state.operation : null,
    reserveOperation: (value) => {
      if (state.operation) {
        throw new Error('Dublê repository: reserva duplicada');
      }
      state.operation = {
        ...value,
        snapshotId: snapshot.id,
        estado: 'pendente',
        criadaEm: '2026-10-29T00:00:00Z',
        resultado: null,
        execucao: null,
      };
      return Promise.resolve(state.operation);
    },
  };
  const executor = createSemogPrismaExecutor({ enabled: true, client, readPdf, observe: options.observe });
  const readCurrent = vi.fn(async () => ({
    envelope: findEnvelope({
      where: {},
      include: { envelopeItems: { include: { documentData: { select: { initialData: true } } } } },
    }),
    pdf: await readPdf({
      documentDataId: state.documentData.id,
      type: state.documentData.type,
      data: state.documentData.initialData,
    }),
  }));
  const service = createSemogSigningService({
    ...base.dependencies,
    repository,
    executor,
    readCurrent,
    observe: options.observe,
  });
  /** The state the sealer leaves: COMPLETED, a new DocumentData holding the sealed file, and the seal receipt. */
  const markSealed = async () => {
    const sealed = await sealedLikePdf();
    const data =
      state.documentData.type === 'S3_PATH' ? semogPdfKeyFor(sha256(sealed)) : Buffer.from(sealed).toString('base64');
    objects.set(data, sealed);
    state.documentData = { ...state.documentData, id: 'sealed', data };
    state.envelope = {
      ...state.envelope,
      status: 'COMPLETED',
      envelopeItems: [{ ...state.envelope.envelopeItems[0], documentDataId: 'sealed' }],
    };
    if (state.operation) {
      state.operation.execucao = { selagem: { documentDataId: 'sealed', hashPdf: sha256(sealed) } };
    }
    return sealed;
  };
  const input = { ...base.input, hashDocumento: snapshot.hashDocumento, hashConsentimento: snapshot.hashConsentimento };
  return { ...base, input, pdf, objects, state, snapshot, readPdf, readCurrent, executor, service, markSealed };
};
