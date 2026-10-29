import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { SemogContactResult } from './contact-contract';
import { ZSemogContactResult } from './contact-contract';
import type { SemogSnapshot } from './contract';
import { semogRefusal } from './route-refusal';
import type { SemogActor } from './service';

export const readSemogContactReplay = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  envelopeId: string,
  key: string,
  hash: string,
) => {
  const rows = await tx.$queryRaw<{ teamId: number; envelopeId: string; hash: string; resultado: unknown }[]>(
    Prisma.sql`SELECT "teamId","envelopeId",hash,resultado FROM semog_bridge.contact_receipts WHERE "chaveOperacao"=${key}::uuid`,
  );
  if (rows.length === 0) {
    return null;
  }
  const result = ZSemogContactResult.safeParse(rows[0].resultado);
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

const ZRevoked = z.object({
  recipientId: z.number().int(),
  expiraEm: z.date(),
  consentimento: z.string().nullable(),
  vigente: z.boolean(),
});
export type SemogRevokedEnrollment = z.infer<typeof ZRevoked>;

/** Capability first, then revocation of every live enrollment of the missing signers, returning what it closed. */
export const revokeSemogMissingEnrollments = async (
  tx: Prisma.TransactionClient,
  key: string,
  envelopeId: string,
  missing: number[],
) => {
  await tx.$queryRaw(Prisma.sql`SELECT set_config('semog_bridge.contact_key',${key},true)`);
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`UPDATE semog_bridge.snapshots SET "revogadaEm"=clock_timestamp()
    WHERE "envelopeId"=${envelopeId} AND "revogadaEm" IS NULL AND "recipientId"=ANY(${missing}::integer[])
    RETURNING "recipientId","expiraEm",conteudo->>'consentimento' AS consentimento,("expiraEm">clock_timestamp()) AS vigente`);
  return rows.map((row) => ZRevoked.parse(row)).sort((a, b) => a.recipientId - b.recipientId);
};

export const saveSemogContactReceipt = async (
  tx: Prisma.TransactionClient,
  actor: SemogActor,
  input: { previousEmail: string; hash: string; result: SemogContactResult },
) => {
  const { result } = input;
  await tx.$executeRaw(Prisma.sql`INSERT INTO semog_bridge.contact_receipts ("chaveOperacao","envelopeId","teamId","userId","recipientId","emailAnterior",email,hash,resultado)
    VALUES (${result.chaveOperacao}::uuid,${result.envelopeId},${actor.teamId},${actor.userId},${result.recipientId},${input.previousEmail},${result.email},${input.hash},${JSON.stringify(result)}::jsonb)`);
};

/** Same SECURITY DEFINER function /inscricoes uses: envelope/recipient locks, uniqueness and expiry checks. */
export const registerSemogSnapshot = async (tx: Prisma.TransactionClient, snapshot: SemogSnapshot) => {
  await tx.$queryRaw(
    Prisma.sql`SELECT public.semog_signing_register_snapshot(${JSON.stringify(snapshot)}::jsonb) AS result`,
  );
};
