import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppErrorCode } from '../../errors/app-error';
import type { SemogPartialSealRequest, SemogPartialSealResult, SemogPartialSealSigner } from './partial-seal-contract';
import { ZSemogPartialSealResult, ZSemogPartialSealSigners } from './partial-seal-contract';
import type { SemogActor } from './service';
import { semogError } from './service-validation';

export const partialSealConflict = () => semogError(AppErrorCode.INVALID_REQUEST, 409);
const ZStoredPartialSeal = z.object({
  chaveOperacao: z.string().uuid(),
  teamId: z.number().int(),
  envelopeId: z.string(),
  rodada: z.number().int(),
  documentDataId: z.string(),
  hashPdf: z.string(),
  assinantes: ZSemogPartialSealSigners,
  criadoEm: z.union([z.date().transform((value) => value.toISOString()), z.string()]),
});

/** Same ownership marker the native sweeps use: only envelopes the bridge activated can be partially sealed. */
export const assertSemogPartialSealManaged = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelopeId: string,
) => {
  const rows = await tx.$queryRaw<{ managed: boolean }[]>(
    Prisma.sql`SELECT EXISTS (SELECT 1 FROM semog_bridge.activation_receipts WHERE "envelopeId"=${envelopeId} AND "teamId"=${actor.teamId}) AS managed`,
  );
  if (rows.length !== 1 || rows[0].managed !== true) {
    throw semogError(AppErrorCode.NOT_FOUND, 404);
  }
};

const toResult = (row: z.infer<typeof ZStoredPartialSeal>): SemogPartialSealResult =>
  ZSemogPartialSealResult.parse({
    chaveOperacao: row.chaveOperacao,
    envelopeId: row.envelopeId,
    rodada: row.rodada,
    hashPdf: row.hashPdf,
    assinados: row.assinantes.filter((signer) => signer.assinou).length,
    total: row.assinantes.length,
    assinantes: row.assinantes,
    criadoEm: row.criadoEm,
  });

/** Idempotency by (envelopeId, rodada) and by key: any partial match is a conflicting replay. */
export const readSemogPartialSealReplay = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelopeId: string,
  input: SemogPartialSealRequest,
) => {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`
    SELECT "chaveOperacao"::text AS "chaveOperacao","teamId","envelopeId",rodada,"documentDataId","hashPdf",assinantes,"criadoEm"
    FROM semog_bridge.partial_seals WHERE ("envelopeId"=${envelopeId} AND rodada=${input.rodada}) OR "chaveOperacao"=${input.chaveOperacao}::uuid`);
  if (rows.length === 0) {
    return null;
  }
  const row = ZStoredPartialSeal.safeParse(rows[0]);
  if (
    rows.length !== 1 ||
    !row.success ||
    row.data.teamId !== actor.teamId ||
    row.data.envelopeId !== envelopeId ||
    row.data.rodada !== input.rodada ||
    row.data.chaveOperacao !== input.chaveOperacao
  ) {
    throw partialSealConflict();
  }
  return toResult(row.data);
};

export const saveSemogPartialSeal = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelopeId: string,
  input: SemogPartialSealRequest,
  seal: { documentDataId: string; hashPdf: string; assinantes: SemogPartialSealSigner[] },
) => {
  await tx.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.partial_seals ("chaveOperacao","teamId","envelopeId",rodada,"documentDataId","hashPdf",assinantes)
    VALUES (${input.chaveOperacao}::uuid,${actor.teamId},${envelopeId},${input.rodada},${seal.documentDataId},${seal.hashPdf},${JSON.stringify(seal.assinantes)}::jsonb)`);
};

export const readSemogPartialSealDocument = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelopeId: string,
  rodada: number,
) => {
  const rows = await tx.$queryRaw<{ documentDataId: string; hashPdf: string }[]>(Prisma.sql`
    SELECT "documentDataId","hashPdf" FROM semog_bridge.partial_seals
    WHERE "envelopeId"=${envelopeId} AND rodada=${rodada} AND "teamId"=${actor.teamId}`);
  if (rows.length !== 1) {
    throw semogError(AppErrorCode.NOT_FOUND, 404);
  }
  return rows[0];
};
