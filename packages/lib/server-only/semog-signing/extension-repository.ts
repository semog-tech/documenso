import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { SemogExtensionResult } from './extension-contract';
import { ZSemogExtensionResult } from './extension-contract';
import { partialSealConflict } from './partial-seal-repository';
import type { SemogActor } from './service';

export const extensionConflict = partialSealConflict;

export const readSemogExtensionReplay = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelopeId: string,
  key: string,
  hash: string,
) => {
  const rows = await tx.$queryRaw<{ teamId: number; envelopeId: string; hash: string; resultado: unknown }[]>(
    Prisma.sql`SELECT "teamId","envelopeId",hash,resultado FROM semog_bridge.extension_receipts WHERE "chaveOperacao"=${key}::uuid`,
  );
  if (rows.length === 0) {
    return null;
  }
  const result = ZSemogExtensionResult.safeParse(rows[0].resultado);
  if (
    rows.length !== 1 ||
    rows[0].teamId !== actor.teamId ||
    rows[0].envelopeId !== envelopeId ||
    rows[0].hash !== hash ||
    !result.success
  ) {
    throw extensionConflict();
  }
  return result.data;
};

/** Recipients with any bridge operation already manifested (signed or refused) through the Semog portal. */
export const readSemogOperationRecipients = async (tx: Prisma.TransactionClient, envelopeId: string) => {
  const rows = await tx.$queryRaw<{ recipientId: number }[]>(
    Prisma.sql`SELECT DISTINCT "recipientId" FROM semog_bridge.operations WHERE "envelopeId"=${envelopeId}`,
  );
  return new Set(rows.map((row) => row.recipientId));
};

const ZActiveSnapshot = z.object({ recipientId: z.number().int(), vigente: z.boolean() });
export const readSemogActiveSnapshots = async (tx: Prisma.TransactionClient, envelopeId: string) => {
  const rows = await tx.$queryRaw<unknown[]>(
    Prisma.sql`SELECT "recipientId",("expiraEm">clock_timestamp()) AS vigente FROM semog_bridge.snapshots
      WHERE "envelopeId"=${envelopeId} AND "revogadaEm" IS NULL`,
  );
  return rows.map((row) => ZActiveSnapshot.parse(row));
};

/**
 * Writes in the order the guard trigger needs: capability, revocation, durable receipt. Only then may
 * Recipient.expiresAt change (see db/2026-10-29-semog-extension.sql).
 */
export const recordSemogExtension = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: { chaveOperacao: string; envelopeId: string; recipientIds: number[]; expiraEm: string; hash: string },
): Promise<SemogExtensionResult> => {
  await tx.$queryRaw(Prisma.sql`SELECT set_config('semog_bridge.extension_key',${input.chaveOperacao},true)`);
  const revoked = await tx.$executeRaw(Prisma.sql`UPDATE semog_bridge.snapshots SET "revogadaEm"=clock_timestamp()
    WHERE "envelopeId"=${input.envelopeId} AND "revogadaEm" IS NULL AND "recipientId"=ANY(${input.recipientIds}::integer[])`);
  const result = ZSemogExtensionResult.parse({
    chaveOperacao: input.chaveOperacao,
    envelopeId: input.envelopeId,
    recipientIds: input.recipientIds,
    expiraEm: input.expiraEm,
    snapshotsRevogados: revoked,
  });
  await tx.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.extension_receipts ("chaveOperacao","envelopeId","teamId","userId","recipientIds","expiraEm",hash,resultado)
    VALUES (${input.chaveOperacao}::uuid,${input.envelopeId},${actor.teamId},${actor.userId},${input.recipientIds}::integer[],${input.expiraEm}::timestamptz,${input.hash},${JSON.stringify(result)}::jsonb)`);
  return result;
};
