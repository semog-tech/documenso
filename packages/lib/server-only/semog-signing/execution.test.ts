import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { createSemogPrismaExecutor } from './execution';
import { createSemogPdfReader, validateSemogPdf } from './initial-pdf';

describe('real Semog execution boundaries', () => {
  it('refuses enabling without an explicit opt-in before accessing Prisma', async () => {
    const transaction = vi.fn();
    const executor = createSemogPrismaExecutor({
      client: { $transaction: transaction },
      readPdf: createSemogPdfReader(),
    });
    await expect(
      executor.execute({ teamId: 1, userId: 1 }, '11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('rejects a PDF-shaped string that is not a document', async () => {
    await expect(validateSemogPdf(new TextEncoder().encode('%PDF-1.7 fake'), [])).rejects.toThrow();
    const document = await PDFDocument.create();
    document.addPage([600, 800]);
    await expect(validateSemogPdf(await document.save(), [])).resolves.toBeUndefined();
  });
  it('does not implicitly read S3 and rejects malformed base64', async () => {
    const reader = createSemogPdfReader();
    await expect(reader({ documentDataId: 'id', type: 'S3_PATH', data: 'private/key' })).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(reader({ documentDataId: 'id', type: 'BYTES_64', data: '**invalid**' })).rejects.toThrow();
  });
});
