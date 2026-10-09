import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppErrorCode } from '../../errors/app-error';
import type { SemogActivationRequest, SemogActivationResult } from './activation-contract';
import { ZSemogActivationResult } from './activation-contract';
import { ZSemogDraftResult } from './draft-contract';
import type { SemogActor } from './service';
import { semogError } from './service-validation';

export const activationConflict = () => semogError(AppErrorCode.INVALID_REQUEST, 409);
export const lockSemogActivation = async (tx: Prisma.TransactionClient, input: SemogActivationRequest) => {
  const key = `semog-activation:${input.operacaoId}`;
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM public."Envelope" WHERE id=${input.envelopeId} FOR UPDATE`);
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM public."Recipient" WHERE "envelopeId"=${input.envelopeId} ORDER BY id FOR UPDATE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM public."Field" WHERE "envelopeId"=${input.envelopeId} ORDER BY id FOR UPDATE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT m.id FROM public."DocumentMeta" m JOIN public."Envelope" e ON e."documentMetaId"=m.id WHERE e.id=${input.envelopeId} FOR UPDATE OF m`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT d.id FROM public."DocumentData" d JOIN public."EnvelopeItem" i ON i."documentDataId"=d.id WHERE i."envelopeId"=${input.envelopeId} FOR UPDATE OF d`,
  );
};
export const readSemogActivationDraft = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: SemogActivationRequest,
) => {
  const rows = await tx.$queryRaw<
    { teamId: number; userId: number; externalId: string; envelopeId: string; resultado: unknown; estrutura: unknown }[]
  >(Prisma.sql`
    SELECT "teamId","userId","externalId","envelopeId",resultado,estrutura FROM semog_bridge.draft_receipts
    WHERE "operacaoId"=${input.rascunhoOperacaoId}::uuid FOR UPDATE`);
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row.teamId !== actor.teamId ||
    row.userId !== actor.userId ||
    row.externalId !== input.externalId ||
    row.envelopeId !== input.envelopeId
  ) {
    throw activationConflict();
  }
  const structure = z
    .object({ versao: z.literal(1), hash: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .safeParse(row.estrutura);
  const result = ZSemogDraftResult.safeParse(row.resultado);
  if (
    !structure.success ||
    !result.success ||
    result.data.operacaoId !== input.rascunhoOperacaoId ||
    result.data.envelopeId !== input.envelopeId ||
    result.data.documento.sha256 !== input.hashPdf
  ) {
    throw activationConflict();
  }
  return { result: result.data, structureHash: structure.data.hash };
};
export const readSemogActivationReplay = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: SemogActivationRequest,
  hash: string,
) => {
  const rows = await tx.$queryRaw<{ teamId: number; userId: number; hash: string; resultado: unknown }[]>(Prisma.sql`
    SELECT "teamId","userId",hash,resultado FROM semog_bridge.activation_receipts
    WHERE "operacaoId"=${input.operacaoId}::uuid OR "envelopeId"=${input.envelopeId} OR "rascunhoOperacaoId"=${input.rascunhoOperacaoId}::uuid`);
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  const result = ZSemogActivationResult.safeParse(row.resultado);
  if (
    rows.length !== 1 ||
    row.teamId !== actor.teamId ||
    row.userId !== actor.userId ||
    row.hash !== hash ||
    !result.success ||
    result.data.operacaoId !== input.operacaoId ||
    result.data.envelopeId !== input.envelopeId ||
    result.data.expiraEm !== input.expiraEm ||
    result.data.hashPdf !== input.hashPdf
  ) {
    throw activationConflict();
  }
  return result.data;
};
export const saveSemogActivation = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: SemogActivationRequest,
  hash: string,
  result: SemogActivationResult,
) => {
  await tx.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.activation_receipts ("operacaoId","rascunhoOperacaoId","envelopeId","teamId","userId",hash,resultado)
    VALUES (${input.operacaoId}::uuid,${input.rascunhoOperacaoId}::uuid,${input.envelopeId},${actor.teamId},${actor.userId},${hash},${JSON.stringify(result)}::jsonb)`);
};
