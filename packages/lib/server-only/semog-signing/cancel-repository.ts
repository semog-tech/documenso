import { Prisma } from '@prisma/client';
import type { SemogCancelResult } from './cancel-contract';
import { ZSemogCancelResult } from './cancel-contract';
import { semogRefusal } from './route-refusal';
import type { SemogActor } from './service';

export const readSemogCancelReplay = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelopeId: string,
  key: string,
  hash: string,
) => {
  const rows = await tx.$queryRaw<{ teamId: number; envelopeId: string; hash: string; resultado: unknown }[]>(
    Prisma.sql`SELECT "teamId","envelopeId",hash,resultado FROM semog_bridge.cancel_receipts WHERE "chaveOperacao"=${key}::uuid`,
  );
  if (rows.length === 0) {
    return null;
  }
  const result = ZSemogCancelResult.safeParse(rows[0].resultado);
  if (
    rows.length !== 1 ||
    rows[0].teamId !== actor.teamId ||
    rows[0].envelopeId !== envelopeId ||
    rows[0].hash !== hash ||
    !result.success
  ) {
    throw semogRefusal({ codigo: 'chave-reutilizada' });
  }
  return result.data;
};

/**
 * A manifestation reserved and still executable: cancelling now would strand it mid-signature. Same condition the
 * executor checks (readActiveSnapshot in execution.ts): its own snapshot, not revoked and not expired. A pending
 * operation whose snapshot expired can never execute (it stays pendente forever), so it must not block the cancel.
 * Race: the executor takes this same Envelope FOR UPDATE before reading the snapshot, and the cancel holds it from
 * here to commit. An executor that got the lock first commits before this read; one that waits reads the snapshot
 * this transaction revoked and answers unavailable. Expiry only ever turns executable into not executable.
 */
export const hasSemogPendingOperation = async (tx: Prisma.TransactionClient, envelopeId: string) => {
  const rows = await tx.$queryRaw<{ pending: boolean }[]>(
    Prisma.sql`SELECT EXISTS (SELECT 1 FROM semog_bridge.operations o JOIN semog_bridge.snapshots s
      ON s.id=o."snapshotId" AND s."teamId"=o."teamId"
      WHERE o."envelopeId"=${envelopeId} AND o.estado='pendente'
        AND s."revogadaEm" IS NULL AND s."expiraEm">clock_timestamp()) AS pending`,
  );
  return rows.length !== 1 || rows[0].pending !== false;
};

/** Durable receipt first, then the capability: the guard only lets the status through once both name it. */
export const saveSemogCancelReceipt = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: { chaveOperacao: string; envelopeId: string; motivo: string; hash: string },
) => {
  await tx.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.cancel_receipts ("chaveOperacao","envelopeId","teamId","userId",motivo,hash)
    VALUES (${input.chaveOperacao}::uuid,${input.envelopeId},${actor.teamId},${actor.userId},${input.motivo},${input.hash})`);
  await tx.$queryRaw(Prisma.sql`SELECT set_config('semog_bridge.cancel_key',${input.chaveOperacao},true)`);
};

/** Runs after the status change, so the guard sees the live snapshots and checks the receipt branch. */
export const revokeSemogEnvelopeEnrollments = async (tx: Prisma.TransactionClient, envelopeId: string) =>
  await tx.$executeRaw(Prisma.sql`UPDATE semog_bridge.snapshots SET "revogadaEm"=clock_timestamp()
    WHERE "envelopeId"=${envelopeId} AND "revogadaEm" IS NULL`);

export const storeSemogCancelResult = async (tx: Prisma.TransactionClient, result: SemogCancelResult) => {
  await tx.$executeRaw(Prisma.sql`UPDATE semog_bridge.cancel_receipts SET resultado=${JSON.stringify(result)}::jsonb
    WHERE "chaveOperacao"=${result.chaveOperacao}::uuid`);
};
