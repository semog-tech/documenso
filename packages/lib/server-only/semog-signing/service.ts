import { AppErrorCode } from '../../errors/app-error';
import { semogAuthenticationMethod } from './auth-evidence';
import type { SemogJsonObject, SemogSnapshot } from './contract';
import type { SemogExecutionResult } from './execution-contract';
import type { createSemogSigningRepository } from './repository';
import type { SemogManifestation } from './service-validation';
import {
  hashSemogManifestation,
  semogError,
  validateSemogFieldValues,
  ZSemogEnrollment,
  ZSemogManifestation,
} from './service-validation';
import { buildSemogSnapshot, canonicalSemogJson } from './snapshot';
import { validateSemogVisualSignature } from './visual';

export type SemogActor = { teamId: number; userId: number };
export type SemogOperationRecord = {
  teamId: number;
  chaveOperacao: string;
  envelopeId: string;
  recipientId: number;
  hashDocumento: string;
  hashConsentimento: string;
  hashPedido: string;
  acao: 'assinar' | 'recusar';
};
export type SemogSigningRepositoryPort = Pick<
  ReturnType<typeof createSemogSigningRepository>,
  'registerSnapshot' | 'getSnapshot' | 'getOperation' | 'reserveOperation'
>;
export type SemogSigningDependencies = {
  enabled?: boolean;
  repository: SemogSigningRepositoryPort;
  authenticate?: (token: string) => Promise<SemogActor | null>;
  readCurrent: (input: { envelopeId: string; actor: SemogActor }) => Promise<{ envelope: unknown; pdf: Uint8Array }>;
  executor?: {
    execute: (actor: SemogActor, key: string) => Promise<SemogExecutionResult>;
    get: (actor: SemogActor, key: string) => Promise<SemogExecutionResult>;
    pdf?: (actor: SemogActor, key: string) => Promise<Uint8Array>;
  };
};

const requireEnabled = (dependencies: SemogSigningDependencies) => {
  if (dependencies.enabled !== true) {
    throw semogError(AppErrorCode.NOT_SETUP, 503);
  }
};
const jsonObject = (value: unknown): SemogJsonObject => {
  const result = canonicalSemogJson(value);
  if (result === null || Array.isArray(result) || typeof result !== 'object') {
    throw semogError(AppErrorCode.INVALID_REQUEST, 400);
  }
  return result;
};
const pendingResult = (operation: SemogOperationRecord) => ({
  chaveOperacao: operation.chaveOperacao,
  envelopeId: operation.envelopeId,
  recipientId: operation.recipientId,
  hashDocumento: operation.hashDocumento,
  hashConsentimento: operation.hashConsentimento,
  acao: operation.acao,
  situacao: 'pendente',
  documentoConcluido: false,
  pdfDisponivel: false,
});
const enrollmentResult = (snapshot: SemogSnapshot) => ({
  id: snapshot.id,
  envelopeId: snapshot.envelopeId,
  recipientId: snapshot.recipientId,
  hashDocumento: snapshot.hashDocumento,
  hashConsentimento: snapshot.hashConsentimento,
  hashSnapshot: snapshot.hashSnapshot,
  expiraEm: snapshot.expiraEm,
});

const checkCurrentSnapshot = async (
  dependencies: SemogSigningDependencies,
  actor: SemogActor,
  snapshot: SemogSnapshot,
  input: SemogManifestation,
) => {
  if (
    snapshot.teamId !== actor.teamId ||
    snapshot.envelopeId !== input.envelopeId ||
    snapshot.recipientId !== input.recipientId ||
    snapshot.hashDocumento !== input.hashDocumento ||
    snapshot.hashConsentimento !== input.hashConsentimento ||
    typeof snapshot.conteudo.consentimento !== 'string'
  ) {
    throw semogError(AppErrorCode.INVALID_REQUEST, 409);
  }
  const current = await dependencies.readCurrent({ envelopeId: input.envelopeId, actor });
  const rebuilt = buildSemogSnapshot({
    ...current,
    teamId: actor.teamId,
    recipientId: input.recipientId,
    consentimento: snapshot.conteudo.consentimento,
    expiraEm: snapshot.expiraEm,
  });
  if (rebuilt.hashSnapshot !== snapshot.hashSnapshot || rebuilt.envelopeId !== input.envelopeId) {
    throw semogError(AppErrorCode.INVALID_REQUEST, 409);
  }
  validateSemogFieldValues(current.envelope, input);
};

/** Defaults to reservation only; an explicitly injected executor applies the native transaction. */
export const createSemogSigningService = (dependencies: SemogSigningDependencies) => ({
  authenticate: async (token: string) => {
    requireEnabled(dependencies);
    if (!token) {
      throw semogError(AppErrorCode.UNAUTHORIZED, 401);
    }
    const actor = await dependencies.authenticate?.(token);
    if (
      !actor ||
      !Number.isSafeInteger(actor.teamId) ||
      actor.teamId <= 0 ||
      !Number.isSafeInteger(actor.userId) ||
      actor.userId <= 0
    ) {
      throw semogError(AppErrorCode.UNAUTHORIZED, 401);
    }
    return actor;
  },
  enroll: async (actor: SemogActor, body: unknown) => {
    requireEnabled(dependencies);
    const input = ZSemogEnrollment.parse(body);
    const current = await dependencies.readCurrent({ envelopeId: input.envelopeId, actor });
    const snapshot = buildSemogSnapshot({ ...current, ...input, teamId: actor.teamId });
    if (snapshot.envelopeId !== input.envelopeId) {
      throw semogError(AppErrorCode.NOT_FOUND, 404);
    }
    const stored = await dependencies.repository.registerSnapshot(snapshot);
    return enrollmentResult({ ...stored, conteudo: jsonObject(stored.conteudo) });
  },
  reserve: async (actor: SemogActor, body: unknown) => {
    requireEnabled(dependencies);
    const input = ZSemogManifestation.parse(body);
    await validateSemogVisualSignature(input);
    const hashPedido = hashSemogManifestation(input);
    const existing = await dependencies.repository.getOperation({
      teamId: actor.teamId,
      chaveOperacao: input.chaveOperacao,
    });
    if (existing) {
      if (existing.teamId !== actor.teamId || existing.hashPedido !== hashPedido) {
        throw semogError(AppErrorCode.INVALID_REQUEST, 409);
      }
      return dependencies.executor
        ? dependencies.executor.execute(actor, input.chaveOperacao)
        : pendingResult(existing);
    }
    const snapshot = await dependencies.repository.getSnapshot({
      teamId: actor.teamId,
      envelopeId: input.envelopeId,
      recipientId: input.recipientId,
    });
    if (!snapshot) {
      throw semogError(AppErrorCode.NOT_FOUND, 404);
    }
    await checkCurrentSnapshot(dependencies, actor, { ...snapshot, conteudo: jsonObject(snapshot.conteudo) }, input);
    const operation = await dependencies.repository.reserveOperation({
      ...input,
      teamId: actor.teamId,
      snapshotId: snapshot.id,
      hashPedido,
      pedido: jsonObject(input),
      evidencias: jsonObject({
        ...input.evidencias,
        metodoAutenticacao: semogAuthenticationMethod(input.evidencias),
      }),
    });
    return dependencies.executor ? dependencies.executor.execute(actor, input.chaveOperacao) : pendingResult(operation);
  },
  get: async (actor: SemogActor, key: string) => {
    requireEnabled(dependencies);
    const operation = await dependencies.repository.getOperation({ teamId: actor.teamId, chaveOperacao: key });
    if (!operation || operation.teamId !== actor.teamId) {
      throw semogError(AppErrorCode.NOT_FOUND, 404);
    }
    return dependencies.executor ? dependencies.executor.get(actor, key) : pendingResult(operation);
  },
  pdf: async (actor: SemogActor, key: string) => {
    requireEnabled(dependencies);
    if (!dependencies.executor?.pdf) {
      throw semogError(AppErrorCode.NOT_SETUP, 503);
    }
    return await dependencies.executor.pdf(actor, key);
  },
});
export type SemogSigningService = ReturnType<typeof createSemogSigningService>;
