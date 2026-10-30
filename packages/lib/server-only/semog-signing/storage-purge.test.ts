import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { semogPdfKeyFor } from './pdf-store';
import type { SemogPurgeLedger, SemogPurgeObjects, SemogPurgeRecord } from './storage-purge';
import { readSemogPurgeSettings, runSemogStoragePurge } from './storage-purge';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.7 ${text}`);
const NOW = new Date('2026-10-30T12:00:00.000Z');
const OLD = new Date('2026-07-01T00:00:00.000Z');

const memoryObjects = (entries: { bytes: Uint8Array; modified?: Date }[], calls: string[]) => {
  const objects = new Map(
    entries.map(({ bytes, modified }) => [semogPdfKeyFor(sha256(bytes)), { bytes, modified: modified ?? OLD }]),
  );
  const store: SemogPurgeObjects = {
    read: vi.fn((key: string) => {
      const object = objects.get(key);
      return object ? Promise.resolve(object.bytes) : Promise.reject(new Error('ausente'));
    }),
    write: vi.fn((key: string, bytes: Uint8Array) => {
      calls.push(`write:${key}`);
      objects.set(key, { bytes, modified: NOW });
      return Promise.resolve();
    }),
    lastModified: vi.fn((key: string) => Promise.resolve(objects.get(key)?.modified ?? null)),
    remove: vi.fn((key: string) => {
      calls.push(`remove:${key}`);
      objects.delete(key);
      return Promise.resolve();
    }),
  };
  return { objects, store };
};

type LedgerState = {
  candidates: string[];
  pending?: string[];
  purgeable?: boolean;
  conflicts?: string[];
  beginError?: Error;
};
const memoryLedger = (state: LedgerState, calls: string[]) => {
  const records = new Map<string, SemogPurgeRecord>();
  const record = (chave: string, estado: SemogPurgeRecord['estado']): SemogPurgeRecord => ({
    id: `p-${chave.slice(10, 18)}`,
    chave,
    envelopes: ['env-cancelado'],
    estado,
  });
  for (const chave of state.pending ?? []) {
    records.set(chave, record(chave, 'pendente'));
  }
  const ledger: SemogPurgeLedger = {
    candidates: vi.fn(() =>
      Promise.resolve(state.candidates.map((chave) => ({ chave, envelopes: ['env-cancelado'], canceladoEm: OLD }))),
    ),
    pendingKeys: vi.fn(() => Promise.resolve(state.pending ?? [])),
    begin: vi.fn(({ chave }: { chave: string }) => {
      calls.push(`begin:${chave}`);
      if (state.beginError) {
        return Promise.reject(state.beginError);
      }
      const existing = records.get(chave) ?? record(chave, 'pendente');
      records.set(chave, existing);
      return Promise.resolve({ ...existing, purgavel: state.purgeable ?? true });
    }),
    conflicts: vi.fn(() => Promise.resolve(state.conflicts ?? [])),
    finish: vi.fn((id: string, absent: boolean) => {
      calls.push(`finish:${id}:${absent}`);
      return Promise.resolve({ ...record('x', 'purgada'), id });
    }),
    abandon: vi.fn((id: string, observacao: string) => {
      calls.push(`abandon:${id}:${observacao}`);
      return Promise.resolve({ ...record('x', 'desistida'), id });
    }),
  };
  return ledger;
};
const options = { retentionDays: 90, graceHours: 24, immediateEnvelopeId: null, quem: 'teste', now: () => NOW };

describe('Purga de PDF de envelope cancelado', () => {
  it('simulação (padrão) só lista: não registra intenção nem apaga', async () => {
    const calls: string[] = [];
    const bytes = pdf('cancelado');
    const { store, objects } = memoryObjects([{ bytes }], calls);
    const key = semogPdfKeyFor(sha256(bytes));
    const ledger = memoryLedger({ candidates: [key] }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: false });
    expect(outcomes).toEqual([expect.objectContaining({ chave: key, resultado: 'simulada' })]);
    expect(calls).toEqual([]);
    expect(objects.has(key)).toBe(true);
  });
  it('registra a intenção ANTES de apagar e conclui depois', async () => {
    const calls: string[] = [];
    const bytes = pdf('cancelado');
    const { store, objects } = memoryObjects([{ bytes }], calls);
    const key = semogPdfKeyFor(sha256(bytes));
    const ledger = memoryLedger({ candidates: [key] }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: true });
    expect(outcomes[0].resultado).toBe('purgada');
    expect(calls).toEqual([`begin:${key}`, `remove:${key}`, `finish:p-${key.slice(10, 18)}:false`]);
    expect(objects.has(key)).toBe(false);
  });
  it('carência: objeto gravado há pouco não é apagado e a intenção é encerrada com o motivo', async () => {
    const calls: string[] = [];
    const bytes = pdf('recente');
    const { store, objects } = memoryObjects([{ bytes, modified: new Date(NOW.getTime() - 3600_000) }], calls);
    const key = semogPdfKeyFor(sha256(bytes));
    const ledger = memoryLedger({ candidates: [key] }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: true });
    expect(outcomes[0].resultado).toBe('adiada');
    expect(calls.some((call) => call.startsWith('remove:'))).toBe(false);
    expect(calls.at(-1)).toMatch(/^abandon:.*carência/);
    expect(objects.has(key)).toBe(true);
  });
  it('objeto já ausente: conclui como ausente, sem tentar apagar', async () => {
    const calls: string[] = [];
    const { store } = memoryObjects([], calls);
    const key = semogPdfKeyFor(sha256(pdf('sumiu')));
    const ledger = memoryLedger({ candidates: [key] }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: true });
    expect(outcomes[0].resultado).toBe('ausente');
    expect(calls).toEqual([`begin:${key}`, `finish:p-${key.slice(10, 18)}:true`]);
  });
  it('retoma intenção pendente que deixou de ser purgável: objeto presente fica, intenção desistida', async () => {
    const calls: string[] = [];
    const bytes = pdf('retomada');
    const { store, objects } = memoryObjects([{ bytes }], calls);
    const key = semogPdfKeyFor(sha256(bytes));
    const ledger = memoryLedger({ candidates: [], pending: [key], purgeable: false }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: true });
    expect(outcomes[0].resultado).toBe('desistida');
    expect(objects.has(key)).toBe(true);
    expect(calls.at(-1)).toMatch(/^abandon:/);
  });
  it('referência nova aparece depois da remoção: restaura os mesmos bytes e não registra purga', async () => {
    const calls: string[] = [];
    const bytes = pdf('reusado');
    const { store, objects } = memoryObjects([{ bytes }], calls);
    const key = semogPdfKeyFor(sha256(bytes));
    const ledger = memoryLedger({ candidates: [key], conflicts: ['dd-novo'] }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: true });
    expect(outcomes[0]).toMatchObject({ resultado: 'restaurada' });
    expect(Buffer.from(objects.get(key)?.bytes ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(calls.filter((call) => call.startsWith('finish:'))).toEqual([]);
    expect(calls.at(-1)).toMatch(/^abandon:.*dd-novo/);
  });
  it('se nem a restauração der certo, registra a purga COM o conflito (a verdade, não o silêncio)', async () => {
    const calls: string[] = [];
    const bytes = pdf('reusado');
    const { store } = memoryObjects([{ bytes }], calls);
    store.write = vi.fn(() => Promise.reject(new Error('bucket travado')));
    const key = semogPdfKeyFor(sha256(bytes));
    const ledger = memoryLedger({ candidates: [key], conflicts: ['dd-novo'] }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: true });
    expect(outcomes[0].resultado).toBe('conflito');
    expect(calls.at(-1)).toBe(`finish:p-${key.slice(10, 18)}:false`);
  });
  it('objeto que não confere com a chave não é apagado', async () => {
    const calls: string[] = [];
    const bytes = pdf('original');
    const { store, objects } = memoryObjects([{ bytes }], calls);
    const key = semogPdfKeyFor(sha256(bytes));
    objects.set(key, { bytes: pdf('adulterado'), modified: OLD });
    const ledger = memoryLedger({ candidates: [key] }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: true });
    expect(outcomes[0].resultado).toBe('desistida');
    expect(objects.has(key)).toBe(true);
  });
  it('falha ao apagar deixa a intenção pendente (retomável) e segue para a próxima chave', async () => {
    const calls: string[] = [];
    const first = pdf('um');
    const second = pdf('dois');
    const { store, objects } = memoryObjects([{ bytes: first }, { bytes: second }], calls);
    const keys = [first, second].map((bytes) => semogPdfKeyFor(sha256(bytes)));
    store.remove = vi.fn((key: string) =>
      key === keys[0] ? Promise.reject(new Error('rede')) : Promise.resolve(void objects.delete(key)),
    );
    const ledger = memoryLedger({ candidates: keys }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: true });
    expect(outcomes.map((outcome) => outcome.resultado)).toEqual(['erro', 'purgada']);
    expect(calls.filter((call) => call.startsWith(`finish:p-${keys[0].slice(10, 18)}`))).toEqual([]);
    expect(objects.has(keys[0])).toBe(true);
  });
  it('chave que deixou de ser candidata entre a lista e o registro é ignorada, sem apagar', async () => {
    const calls: string[] = [];
    const bytes = pdf('corrida');
    const { store, objects } = memoryObjects([{ bytes }], calls);
    const key = semogPdfKeyFor(sha256(bytes));
    const ledger = memoryLedger({ candidates: [key], beginError: new Error('Key is not purgeable') }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: true });
    expect(outcomes[0].resultado).toBe('ignorada');
    expect(objects.has(key)).toBe(true);
  });
  it('falha ao registrar a intenção (banco fora) é erro, não "ignorada", e nada é apagado', async () => {
    const calls: string[] = [];
    const bytes = pdf('banco fora');
    const { store, objects } = memoryObjects([{ bytes }], calls);
    const key = semogPdfKeyFor(sha256(bytes));
    const ledger = memoryLedger({ candidates: [key], beginError: new Error('Can not reach database server') }, calls);
    const outcomes = await runSemogStoragePurge({ ledger, objects: store }, { ...options, apply: true });
    expect(outcomes[0].resultado).toBe('erro');
    expect(objects.has(key)).toBe(true);
  });
  it('carência zero só na purga imediata de um envelope nomeado, com motivo', async () => {
    const calls: string[] = [];
    const bytes = pdf('ata de teste');
    const { store, objects } = memoryObjects([{ bytes, modified: NOW }], calls);
    const key = semogPdfKeyFor(sha256(bytes));
    const ledger = memoryLedger({ candidates: [key] }, calls);
    await expect(
      runSemogStoragePurge({ ledger, objects: store }, { ...options, graceHours: 0, apply: true }),
    ).rejects.toThrow(/carência/i);
    await expect(
      runSemogStoragePurge(
        { ledger, objects: store },
        { ...options, graceHours: 0, immediateEnvelopeId: 'env-cancelado', apply: true },
      ),
    ).rejects.toThrow(/motivo/i);
    const outcomes = await runSemogStoragePurge(
      { ledger, objects: store },
      { ...options, graceHours: 0, immediateEnvelopeId: 'env-cancelado', motivo: 'Ata de teste', apply: true },
    );
    expect(outcomes[0].resultado).toBe('purgada');
    expect(objects.has(key)).toBe(false);
  });
  it('configuração: retenção padrão de 90 dias, carência de 24 h, e valor inválido é recusado', () => {
    expect(readSemogPurgeSettings(() => undefined)).toEqual({ retentionDays: 90, graceHours: 24 });
    expect(
      readSemogPurgeSettings(
        (name) => ({ SEMOG_CANCELLED_RETENTION_DAYS: '30' })[name as 'SEMOG_CANCELLED_RETENTION_DAYS'],
      ),
    ).toEqual({ retentionDays: 30, graceHours: 24 });
    for (const bad of ['0', '-1', '1.5', 'noventa']) {
      expect(() =>
        readSemogPurgeSettings((name) => (name === 'SEMOG_CANCELLED_RETENTION_DAYS' ? bad : undefined)),
      ).toThrow();
    }
  });
});
