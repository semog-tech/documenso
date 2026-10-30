import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { createSemogDraftService } from './draft-service';
import { createSemogPdfReader } from './initial-pdf';
import type { SemogPdfStore } from './pdf-store';
import { persistSemogDerivedPdf, readSemogStoredPdf, semogPdfKeyFor } from './pdf-store';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const memoryStore = () => {
  const objects = new Map<string, Uint8Array>();
  const store: SemogPdfStore = {
    read: vi.fn((key: string) => {
      const bytes = objects.get(key);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error('ausente'));
    }),
    write: vi.fn((key: string, bytes: Uint8Array) => {
      objects.set(key, bytes);
      return Promise.resolve();
    }),
  };
  return { objects, store };
};
const bytes = new TextEncoder().encode('%PDF-1.7 armazenado');

describe('Armazenamento de PDF endereçado por conteúdo', () => {
  it('lê só chaves da ponte e só quando os bytes batem com o hash da chave', async () => {
    const { objects, store } = memoryStore();
    const key = semogPdfKeyFor(sha256(bytes));
    objects.set(key, bytes);
    expect(await readSemogStoredPdf(store, key)).toBe(bytes);
    objects.set(key, new TextEncoder().encode('%PDF-1.7 trocado'));
    await expect(readSemogStoredPdf(store, key)).rejects.toMatchObject({ statusCode: 409 });
    objects.set('abc123/qualquer.pdf', bytes);
    await expect(readSemogStoredPdf(store, 'abc123/qualquer.pdf')).rejects.toMatchObject({ statusCode: 409 });
    expect(store.read).toHaveBeenCalledTimes(2);
  });
  it('o leitor da ponte recusa S3_PATH sem armazenamento configurado e mantém BYTES_64', async () => {
    await expect(
      createSemogPdfReader()({ documentDataId: 'd', type: 'S3_PATH', data: 'semog/pdf/x.pdf' }),
    ).rejects.toMatchObject({
      statusCode: 503,
    });
    const inline = Buffer.from(bytes).toString('base64');
    expect(
      Buffer.from(await createSemogPdfReader()({ documentDataId: 'd', type: 'BYTES_64', data: inline })).equals(
        Buffer.from(bytes),
      ),
    ).toBe(true);
  });
  it('selado segue o armazenamento do original e nunca mistura tipos na mesma DocumentData', async () => {
    const { objects, store } = memoryStore();
    expect(await persistSemogDerivedPdf(store, 'BYTES_64', bytes)).toEqual({
      type: 'BYTES_64',
      data: Buffer.from(bytes).toString('base64'),
    });
    expect(objects.size).toBe(0);
    expect(await persistSemogDerivedPdf(store, 'S3_PATH', bytes)).toEqual({
      type: 'S3_PATH',
      data: semogPdfKeyFor(sha256(bytes)),
    });
    expect(objects.get(semogPdfKeyFor(sha256(bytes)))).toBe(bytes);
    await expect(persistSemogDerivedPdf(undefined, 'S3_PATH', bytes)).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('Rascunho com armazenamento de objetos', () => {
  const draftBody = async () => {
    const document = await PDFDocument.create();
    document.addPage();
    const pdf = await document.save();
    const field = { pagina: 1, x: 10, y: 10, largura: 20, altura: 10, obrigatorio: true };
    return {
      pdf,
      body: {
        operacaoId: randomUUID(),
        externalId: randomUUID(),
        versao: 1,
        ordemAssinatura: 'paralela',
        titulo: 'Rascunho',
        arquivo: { nome: 'a.pdf', pdfBase64: Buffer.from(pdf).toString('base64'), sha256: sha256(pdf) },
        signatarios: [
          {
            referencia: randomUUID(),
            nome: 'Pessoa',
            email: 'pessoa@example.invalid',
            ordem: 0,
            role: 'SIGNER',
            campos: [{ ...field, referencia: randomUUID(), tipo: 'SIGNATURE', papel: 'assinatura' }],
          },
        ],
      },
    };
  };
  it('sobe o PDF sob a chave do hash ANTES de abrir a transação', async () => {
    const { objects, store } = memoryStore();
    const { pdf, body } = await draftBody();
    const key = semogPdfKeyFor(sha256(pdf));
    const transaction = vi.fn(() => {
      // The object must already be there: the transaction only references it.
      expect(Buffer.from(objects.get(key) ?? []).equals(Buffer.from(pdf))).toBe(true);
      return Promise.reject(new Error('transação interrompida no teste'));
    });
    const service = createSemogDraftService({
      enabled: true,
      client: { $transaction: transaction },
      authenticate: async () => ({ teamId: 1, userId: 1 }),
      pdfStore: store,
    });
    await expect(service.create({ teamId: 1, userId: 1 }, body)).rejects.toThrow('interrompida');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(store.write).toHaveBeenCalledTimes(1);
  });
});
