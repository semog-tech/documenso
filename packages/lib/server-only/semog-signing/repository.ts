import { z } from 'zod';

import { AppError } from '../../errors/app-error';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObjectSchema = z.record(z.unknown());
const snapshotSchema = z.object({
  id: z.string().uuid(),
  teamId: z.number().int().positive(),
  envelopeId: z.string().min(1),
  recipientId: z.number().int().positive(),
  hashDocumento: hashSchema,
  hashConsentimento: hashSchema,
  hashSnapshot: hashSchema,
  expiraEm: z.string().datetime({ offset: true }),
  conteudo: jsonObjectSchema,
});

const operationInputSchema = z.object({
  chaveOperacao: z.string().uuid(),
  snapshotId: z.string().uuid(),
  teamId: z.number().int().positive(),
  envelopeId: z.string().min(1),
  recipientId: z.number().int().positive(),
  hashDocumento: hashSchema,
  hashConsentimento: hashSchema,
  acao: z.enum(['assinar', 'recusar']),
  hashPedido: hashSchema,
  pedido: jsonObjectSchema,
  evidencias: jsonObjectSchema,
});
const operationSchema = operationInputSchema.extend({
  criadaEm: z.string().datetime({ offset: true }),
  estado: z.enum(['pendente', 'concluida']),
});
const lookupSchema = z.object({ teamId: z.number().int().positive(), chaveOperacao: z.string().uuid() });
const revokeSchema = z.object({ teamId: z.number().int().positive(), snapshotId: z.string().uuid() });

export type SemogSigningSnapshot = z.infer<typeof snapshotSchema>;
export type SemogSigningOperationInput = z.infer<typeof operationInputSchema>;
export type SemogSigningOperation = z.infer<typeof operationSchema>;
export type SemogSigningRpcClient = {
  rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type SemogSigningSqlClient = {
  query: (text: string, values: unknown[]) => Promise<{ rows: { result: unknown }[] }>;
};

const buildStatements = (params: Record<string, unknown>): Record<string, { text: string; values: unknown[] }> => ({
  semog_signing_register_snapshot: {
    text: 'SELECT public.semog_signing_register_snapshot($1::jsonb) AS result',
    values: [JSON.stringify(params.p_snapshot)],
  },
  semog_signing_get_snapshot: {
    text: 'SELECT public.semog_signing_get_snapshot($1::integer,$2::text,$3::integer) AS result',
    values: [params.p_team_id, params.p_envelope_id, params.p_recipient_id],
  },
  semog_signing_revoke_snapshot: {
    text: 'SELECT public.semog_signing_revoke_snapshot($1::integer,$2::uuid) AS result',
    values: [params.p_team_id, params.p_id],
  },
  semog_signing_reserve_operation: {
    text: 'SELECT public.semog_signing_reserve_operation($1::jsonb) AS result',
    values: [JSON.stringify(params.p_operation)],
  },
  semog_signing_get_operation: {
    text: 'SELECT public.semog_signing_get_operation($1::integer,$2::uuid) AS result',
    values: [params.p_team_id, params.p_key],
  },
});

// This is a PostgreSQL function adapter, not a PostgREST endpoint. Identifiers are allowlisted.
const executeStatement = async (client: SemogSigningSqlClient, statement: { text: string; values: unknown[] }) => {
  try {
    return await client.query(statement.text, statement.values);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new AppError('INVALID_REQUEST', { message: 'Signing persistence conflict', statusCode: 409 });
    }
    throw error;
  }
};

export const createSemogSigningPostgresClient = (client: SemogSigningSqlClient): SemogSigningRpcClient => ({
  rpc: async (name, params) => {
    const statements = buildStatements(params);
    const statement = statements[name];
    if (!Object.hasOwn(statements, name)) {
      throw new AppError('INVALID_REQUEST', { message: 'Unsupported signing persistence function' });
    }
    const response = await executeStatement(client, statement);
    if (response.rows.length !== 1) {
      throw new AppError('UNKNOWN_ERROR', { message: 'Invalid signing persistence result' });
    }
    return { data: response.rows[0].result, error: null };
  },
});

// Only a trusted server supplies teamId; this factory never derives identity from a public body.
export const createSemogSigningRepository = (client: SemogSigningRpcClient) => {
  const call = async (name: string, params: Record<string, unknown>) => {
    try {
      const result = await client.rpc(name, params);
      if (result.error) {
        throw new AppError('INVALID_REQUEST', { message: 'Signing persistence rejected the request' });
      }
      return result.data;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('UNKNOWN_ERROR', { message: 'Signing persistence is unavailable' });
    }
  };

  return {
    registerSnapshot: async (input: SemogSigningSnapshot) =>
      snapshotSchema.parse(await call('semog_signing_register_snapshot', { p_snapshot: snapshotSchema.parse(input) })),
    getSnapshot: async (input: { teamId: number; envelopeId: string; recipientId: number }) => {
      const data = snapshotSchema.pick({ teamId: true, envelopeId: true, recipientId: true }).parse(input);
      const result = await call('semog_signing_get_snapshot', {
        p_team_id: data.teamId,
        p_envelope_id: data.envelopeId,
        p_recipient_id: data.recipientId,
      });
      return result === null ? null : snapshotSchema.parse(result);
    },
    revokeSnapshot: async (input: z.infer<typeof revokeSchema>) => {
      const data = revokeSchema.parse(input);
      z.literal(true).parse(
        await call('semog_signing_revoke_snapshot', { p_team_id: data.teamId, p_id: data.snapshotId }),
      );
    },
    reserveOperation: async (input: SemogSigningOperationInput) =>
      operationSchema.parse(
        await call('semog_signing_reserve_operation', { p_operation: operationInputSchema.parse(input) }),
      ),
    getOperation: async (input: z.infer<typeof lookupSchema>) => {
      const data = lookupSchema.parse(input);
      const result = await call('semog_signing_get_operation', { p_team_id: data.teamId, p_key: data.chaveOperacao });
      return result === null ? null : operationSchema.parse(result);
    },
  };
};
