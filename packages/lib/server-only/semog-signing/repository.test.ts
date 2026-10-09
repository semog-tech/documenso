import { describe, expect, it, vi } from 'vitest';

import {
  createSemogSigningPostgresClient,
  createSemogSigningRepository,
  type SemogSigningSnapshot,
} from './repository';

const snapshot: SemogSigningSnapshot = {
  id: 'bcb1161e-17d5-4d3b-9d01-4aaf515818aa',
  teamId: 1,
  envelopeId: 'envelope',
  recipientId: 1,
  hashDocumento: 'a'.repeat(64),
  hashConsentimento: 'b'.repeat(64),
  hashSnapshot: 'c'.repeat(64),
  expiraEm: '2030-01-01T00:00:00Z',
  conteudo: { declaration: 'I agree' },
};

describe('signing persistence boundary', () => {
  it('maps only PostgreSQL uniqueness conflicts to a sanitized conflict', async () => {
    const query = vi.fn().mockRejectedValue({ code: '23505', detail: 'private tenant evidence' });
    const repository = createSemogSigningRepository(createSemogSigningPostgresClient({ query }));
    await expect(repository.registerSnapshot(snapshot)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Signing persistence conflict',
      statusCode: 409,
    });
  });
  it('keeps privilege errors as unavailable rather than pretending a conflict', async () => {
    const query = vi.fn().mockRejectedValue({ code: '42501', detail: 'private table privileges' });
    const repository = createSemogSigningRepository(createSemogSigningPostgresClient({ query }));
    await expect(repository.registerSnapshot(snapshot)).rejects.toMatchObject({
      code: 'UNKNOWN_ERROR',
      message: 'Signing persistence is unavailable',
    });
  });
  it('uses parameterized PostgreSQL and a fixed function allowlist', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ result: snapshot }] });
    const client = createSemogSigningPostgresClient({ query });
    await expect(client.rpc('toString', {})).rejects.toThrow('Unsupported');
    expect(query).not.toHaveBeenCalled();
    await createSemogSigningRepository(client).registerSnapshot(snapshot);
    expect(query).toHaveBeenCalledWith('SELECT public.semog_signing_register_snapshot($1::jsonb) AS result', [
      JSON.stringify(snapshot),
    ]);
  });
  it('validates before writing', async () => {
    const rpc = vi.fn();
    await expect(
      createSemogSigningRepository({ rpc }).registerSnapshot({ ...snapshot, hashDocumento: 'bad' }),
    ).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('passes the exact snapshot and validates stored response', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: snapshot, error: null });
    expect(await createSemogSigningRepository({ rpc }).registerSnapshot(snapshot)).toEqual(snapshot);
    expect(rpc).toHaveBeenCalledWith('semog_signing_register_snapshot', { p_snapshot: snapshot });
  });
  it('rejects malformed stored responses', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ...snapshot, recipientId: -1 }, error: null });
    await expect(createSemogSigningRepository({ rpc }).registerSnapshot(snapshot)).rejects.toThrow();
  });
  it('does not leak database messages', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'secret password' } });
    await expect(createSemogSigningRepository({ rpc }).registerSnapshot(snapshot)).rejects.toThrow(
      'Signing persistence rejected',
    );
  });
  it('handles connection rejection', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('secret connection'));
    await expect(createSemogSigningRepository({ rpc }).registerSnapshot(snapshot)).rejects.toThrow(
      'Signing persistence is unavailable',
    );
  });
  it('allows absent operations without manufacturing success', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    expect(
      await createSemogSigningRepository({ rpc }).getOperation({ teamId: 1, chaveOperacao: snapshot.id }),
    ).toBeNull();
  });
  it('rejects a completed operation because motor completion is not implemented', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { estado: 'concluido' }, error: null });
    await expect(
      createSemogSigningRepository({ rpc }).getOperation({ teamId: 1, chaveOperacao: snapshot.id }),
    ).rejects.toThrow();
  });
});
