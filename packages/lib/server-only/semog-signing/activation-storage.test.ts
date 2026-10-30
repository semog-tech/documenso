import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createSemogActivationService } from './activation-service';
import { semogDraftDocumentMatches } from './activation-validation';
import type { SemogPdfStore } from './pdf-store';
import { readSemogStoredPdf, semogPdfKeyFor } from './pdf-store';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pdf = new TextEncoder().encode('%PDF-1.7 rascunho no bucket');
const hash = sha256(pdf);
const key = semogPdfKeyFor(hash);
const memory = (objects: Map<string, Uint8Array>): SemogPdfStore => ({
  read: vi.fn((name: string) => {
    const bytes = objects.get(name);
    return bytes ? Promise.resolve(bytes) : Promise.reject(new Error('ausente'));
  }),
  write: vi.fn(() => Promise.reject(new Error('a ativação não grava'))),
});
const stored = (data: string) => ({ id: 'd', type: 'S3_PATH' as const, data, initialData: data });

describe('Ativação de rascunho no armazenamento de objetos', () => {
  it('aceita só a chave do hash do rascunho, e só se essa chave foi conferida por conteúdo', () => {
    expect(semogDraftDocumentMatches(stored(key), hash, key)).toBe(true);
    expect(semogDraftDocumentMatches(stored(key), hash, null)).toBe(false);
    expect(semogDraftDocumentMatches(stored(key), 'b'.repeat(64), key)).toBe(false);
    const other = semogPdfKeyFor('c'.repeat(64));
    expect(semogDraftDocumentMatches(stored(other), hash, other)).toBe(false);
    expect(semogDraftDocumentMatches({ ...stored(key), initialData: other }, hash, key)).toBe(false);
  });
  it('o ramo inline continua exigindo o Base64 que decodifica no hash do rascunho', () => {
    const inline = Buffer.from(pdf).toString('base64');
    const row = { id: 'd', type: 'BYTES_64' as const, data: inline, initialData: inline };
    expect(semogDraftDocumentMatches(row, hash, null)).toBe(true);
    expect(semogDraftDocumentMatches(row, 'b'.repeat(64), null)).toBe(false);
  });
  const service = (objects: Map<string, Uint8Array>) => {
    const transactions: string[] = [];
    const client = {
      $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: string }) => {
        if (transactions.push(String(options?.isolationLevel)) > 1) {
          // The activation transaction itself: reaching it means the object passed the content check.
          return Promise.reject(new Error('transação de ativação alcançada'));
        }
        const tx = { documentData: { findFirst: () => Promise.resolve({ type: 'S3_PATH', data: key }) } };
        // Only the pre-transaction read of the draft's DocumentData is implemented here.
        return fn(tx as unknown as Prisma.TransactionClient);
      },
    };
    const store = memory(objects);
    const activation = createSemogActivationService({
      enabled: true,
      client,
      pdfStore: store,
      authenticate: async () => ({ teamId: 1, userId: 1 }),
    });
    const body = {
      operacaoId: randomUUID(),
      rascunhoOperacaoId: randomUUID(),
      envelopeId: 'env',
      externalId: randomUUID(),
      hashPdf: hash,
      expiraEm: '2099-01-01T00:00:00.000Z',
    };
    return { activation, body, store, transactions };
  };
  it('lê o objeto antes da transação e segue só quando os bytes batem com a chave', async () => {
    const accepted = service(new Map([[key, pdf]]));
    await expect(accepted.activation.activate({ teamId: 1, userId: 1 }, accepted.body)).rejects.toThrow('alcançada');
    expect(accepted.store.read).toHaveBeenCalledWith(key);
    const tampered = service(new Map([[key, new TextEncoder().encode('%PDF-1.7 adulterado')]]));
    await expect(tampered.activation.activate({ teamId: 1, userId: 1 }, tampered.body)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(tampered.transactions).toHaveLength(1);
  });
});

describe('Formato da chave do PDF', () => {
  it('só aceita semog/pdf/<64 hex minúsculos>.pdf exato, sem ler o armazenamento nos demais', async () => {
    const store = memory(new Map([[key, pdf]]));
    const forged = [
      key.toUpperCase(),
      `semog/pdf/${hash.toUpperCase()}.pdf`,
      `x/${key}`,
      `${key}.bak`,
      `${key}\n`,
      `\n${key}`,
      `semog/pdf/../pdf/${hash}.pdf`,
      `semog/pdf/${hash.slice(1)}.pdf`,
      `semog/pdf/${hash}a.pdf`,
      `semog/pdf/${hash}.PDF`,
    ];
    for (const candidate of forged) {
      await expect(readSemogStoredPdf(store, candidate)).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(store.read).not.toHaveBeenCalled();
    expect(await readSemogStoredPdf(store, key)).toBe(pdf);
  });
});
