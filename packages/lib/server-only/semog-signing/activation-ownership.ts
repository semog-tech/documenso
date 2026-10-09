import { Prisma } from '@prisma/client';

type Lookup = Pick<Prisma.TransactionClient, '$queryRaw'>;
const hasActivationTable = async (client: Lookup) => {
  const tables = await client.$queryRaw<{ present: boolean }[]>(
    Prisma.sql`SELECT to_regclass('semog_bridge.activation_receipts') IS NOT NULL AS present`,
  );
  if (tables.length !== 1 || typeof tables[0].present !== 'boolean') {
    throw new Error('Semog activation ownership lookup unavailable');
  }
  return tables[0].present;
};
/** Failure propagates before dispatch; absence is only valid for a host where the feature was never migrated. */
export const isSemogActivationManaged = async (client: Lookup, envelopeId: string): Promise<boolean> => {
  if (!(await hasActivationTable(client))) {
    return false;
  }
  const rows = await client.$queryRaw<{ managed: boolean }[]>(
    Prisma.sql`SELECT EXISTS (SELECT 1 FROM semog_bridge.activation_receipts WHERE "envelopeId"=${envelopeId}) AS managed`,
  );
  if (rows.length !== 1 || typeof rows[0].managed !== 'boolean') {
    throw new Error('Semog activation ownership lookup unavailable');
  }
  return rows[0].managed;
};
/** Exclude managed envelopes before the stock take(1000), so skipped Semog rows cannot starve native recipients. */
export const listSemogActivationManaged = async (client: Lookup): Promise<string[]> => {
  if (!(await hasActivationTable(client))) {
    return [];
  }
  const rows = await client.$queryRaw<{ envelopeId: string }[]>(Prisma.sql`
    SELECT r."envelopeId" FROM semog_bridge.activation_receipts r JOIN public."Envelope" e ON e.id=r."envelopeId" WHERE e.status='PENDING'`);
  if (!Array.isArray(rows) || rows.some((row) => typeof row.envelopeId !== 'string')) {
    throw new Error('Semog activation ownership lookup unavailable');
  }
  return rows.map((row) => row.envelopeId);
};
export const filterSemogUnmanaged = async <T>(client: Lookup, entries: T[], envelopeId: (entry: T) => string) => {
  const managed = await Promise.all(entries.map((entry) => isSemogActivationManaged(client, envelopeId(entry))));
  return entries.filter((_, index) => !managed[index]);
};
