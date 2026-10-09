import { Prisma } from '@prisma/client';
import { AppErrorCode } from '../../errors/app-error';
import type { SemogDraftRequest, SemogDraftResult } from './draft-contract';
import { ZSemogDraftResult } from './draft-contract';
import { hashSemogDraftStructure, readSemogDraftStructure } from './draft-structure';
import type { SemogActor } from './service';
import { semogError } from './service-validation';

export const lockSemogDraft = async (tx: Prisma.TransactionClient, actor: SemogActor, input: SemogDraftRequest) => {
  // READ COMMITTED + transaction advisory locks: waiter reads the receipt committed by the winner.
  const externalLock = `semog-draft-external:${actor.teamId}:${input.externalId}`;
  const operationLock = `semog-draft-operation:${input.operacaoId}`;
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${externalLock},0))::text`);
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationLock},0))::text`);
};
export const replaySemogDraft = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: SemogDraftRequest,
  hash: string,
) => {
  const rows = await tx.$queryRaw<{ teamId: number; userId: number; hash: string; resultado: unknown }[]>(Prisma.sql`
    SELECT "teamId","userId",hash,resultado FROM semog_bridge.draft_receipts
    WHERE "operacaoId"=${input.operacaoId}::uuid OR ("teamId"=${actor.teamId} AND "externalId"=${input.externalId}::uuid)`);
  if (rows.length === 0) {
    return null;
  }
  const [receipt] = rows;
  if (
    rows.length !== 1 ||
    receipt.teamId !== actor.teamId ||
    receipt.userId !== actor.userId ||
    receipt.hash !== hash
  ) {
    throw semogError(AppErrorCode.INVALID_REQUEST, 409);
  }
  const result = ZSemogDraftResult.parse(receipt.resultado);
  if (result.operacaoId !== input.operacaoId || result.documento.sha256 !== input.arquivo.sha256) {
    throw semogError(AppErrorCode.INVALID_REQUEST, 409);
  }
  return result;
};
export const saveSemogDraftReceipt = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: SemogDraftRequest,
  hash: string,
  result: SemogDraftResult,
) => {
  const structure = hashSemogDraftStructure(await readSemogDraftStructure(tx, result.envelopeId));
  await tx.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.draft_receipts ("operacaoId","externalId","teamId","userId",hash,"envelopeId",resultado,estrutura)
    VALUES (${input.operacaoId}::uuid,${input.externalId}::uuid,${actor.teamId},${actor.userId},${hash},${result.envelopeId},${JSON.stringify(result)}::jsonb,${JSON.stringify({ versao: 1, hash: structure })}::jsonb)`);
};
