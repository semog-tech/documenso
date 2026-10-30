import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SemogPdfStore } from './pdf-store';
import { semogPdfKeyFor } from './pdf-store';
import type { SemogStoragePlanRow } from './storage-migration';
import { migrateSemogCancelledInline, migrateSemogStorageRow } from './storage-migration';

const bytes = new TextEncoder().encode('%PDF-1.7 migrado');
const key = semogPdfKeyFor(createHash('sha256').update(bytes).digest('hex'));
const row: SemogStoragePlanRow = {
  id: 'dd',
  bytes: bytes.byteLength,
  dataKey: key,
  initialKey: key,
  envelopeId: 'env',
  orfa: false,
  status: 'PENDING',
  ponte: true,
  eligible: true,
  motivo: null,
  elegivelEm: null,
};

describe('Cancelados inline antes da purga', () => {
  it('linha que falha não derruba as outras: falhas voltam nomeadas, sem conteúdo do PDF', async () => {
    const objects = new Map<string, Uint8Array>();
    const store: SemogPdfStore = {
      read: (candidate) => {
        const found = objects.get(candidate);
        return found ? Promise.resolve(found) : Promise.reject(new Error('ausente'));
      },
      write: (candidate, value) => {
        objects.set(candidate, value);
        return Promise.resolve();
      },
    };
    const base64 = Buffer.from(bytes).toString('base64');
    const plan = [
      { ...row, id: 'quebrada', envelopeId: 'env-1', status: 'CANCELLED' },
      { ...row, id: 'boa', envelopeId: 'env-2', status: 'CANCELLED' },
    ];
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(plan)
      // The first row is no longer inline when read (raced): it fails alone.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ data: base64, initialData: base64 }])
      .mockResolvedValueOnce([{ result: { id: 'boa' } }]);
    const result = await migrateSemogCancelledInline({ $queryRaw: queryRaw }, store, null);
    expect(result.migrated).toEqual(['boa']);
    expect(result.failed).toEqual([
      { id: 'quebrada', envelopeId: 'env-1', erro: expect.stringMatching(/não está mais inline/) },
    ]);
    expect(JSON.stringify(result)).not.toContain(base64.slice(0, 16));
  });
});

describe('Migração inline -> R2', () => {
  it('objeto apagado entre o upload e o commit (purga) é regravado depois do commit', async () => {
    const objects = new Map<string, Uint8Array>();
    const store: SemogPdfStore = {
      read: (candidate) => {
        const found = objects.get(candidate);
        return found ? Promise.resolve(found) : Promise.reject(new Error('ausente'));
      },
      write: (candidate, value) => {
        objects.set(candidate, value);
        return Promise.resolve();
      },
    };
    const base64 = Buffer.from(bytes).toString('base64');
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ data: base64, initialData: base64 }])
      .mockImplementationOnce(() => {
        // The database function commits the swap while the purge removes the object.
        objects.delete(key);
        return Promise.resolve([{ result: { id: 'dd' } }]);
      });
    await migrateSemogStorageRow({ $queryRaw: queryRaw }, store, row);
    expect(Buffer.from(objects.get(key) ?? []).equals(Buffer.from(bytes))).toBe(true);
  });
});
