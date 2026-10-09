import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { ZSemogDraftRequest } from './draft-contract';
import { semogDraftMaximum, validateSemogDraft } from './draft-validation';

const draftFixture = async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = await pdf.save();
  return {
    operacaoId: randomUUID(),
    externalId: randomUUID(),
    versao: 1,
    ordemAssinatura: 'paralela',
    titulo: 'Documento de teste local',
    arquivo: {
      nome: 'local.pdf',
      pdfBase64: Buffer.from(bytes).toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    signatarios: [
      {
        referencia: randomUUID(),
        nome: 'Pessoa Local',
        email: 'local@example.invalid',
        ordem: 0,
        role: 'SIGNER',
        campos: [
          {
            referencia: randomUUID(),
            tipo: 'TEXT',
            papel: 'cpf',
            pagina: 1,
            x: 10,
            y: 10,
            largura: 25,
            altura: 5,
            obrigatorio: true,
          },
          {
            referencia: randomUUID(),
            tipo: 'TEXT',
            papel: 'observacao',
            pagina: 1,
            x: 10,
            y: 20,
            largura: 40,
            altura: 5,
            obrigatorio: false,
          },
          {
            referencia: randomUUID(),
            tipo: 'SIGNATURE',
            papel: 'assinatura',
            pagina: 1,
            x: 10,
            y: 30,
            largura: 40,
            altura: 10,
            obrigatorio: true,
          },
        ],
      },
    ],
  };
};
describe('Semog draft validation', () => {
  it('parses real PDF and canonical payload; hash includes geometry, role and title', async () => {
    const input = await draftFixture();
    const first = await validateSemogDraft(input, 50000);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await validateSemogDraft({ ...input, titulo: 'Outro' }, 50000)).hash).not.toBe(first.hash);
    expect(
      (
        await validateSemogDraft(
          {
            ...input,
            signatarios: input.signatarios.map((recipient) => ({
              ...recipient,
              campos: recipient.campos.map((field) => ({ ...field, x: field.x + 1 })),
            })),
          },
          50000,
        )
      ).hash,
    ).not.toBe(first.hash);
  });
  it('rejects hash divergence, noncanonical base64 and fake PDF despite magic bytes', async () => {
    const input = await draftFixture();
    await expect(
      validateSemogDraft({ ...input, arquivo: { ...input.arquivo, sha256: 'a'.repeat(64) } }, 50000),
    ).rejects.toBeDefined();
    await expect(
      validateSemogDraft({ ...input, arquivo: { ...input.arquivo, pdfBase64: `${input.arquivo.pdfBase64}\n` } }, 50000),
    ).rejects.toBeDefined();
    const fake = Buffer.from('%PDF-not-a-document');
    await expect(
      validateSemogDraft(
        {
          ...input,
          arquivo: {
            ...input.arquivo,
            pdfBase64: fake.toString('base64'),
            sha256: createHash('sha256').update(fake).digest('hex'),
          },
        },
        50000,
      ),
    ).rejects.toBeDefined();
  });
  it('rejects absent PDF page, overflow, repeated references and wrong version', async () => {
    const input = await draftFixture();
    input.signatarios[0].campos[0].pagina = 2;
    await expect(validateSemogDraft(input, 50000)).rejects.toBeDefined();
    input.signatarios[0].campos[0].pagina = 1;
    input.signatarios[0].campos[0].x = 99;
    expect(ZSemogDraftRequest.safeParse(input).success).toBe(false);
    input.signatarios[0].campos[0].x = 10;
    input.signatarios[0].campos[1].referencia = input.signatarios[0].campos[0].referencia;
    expect(ZSemogDraftRequest.safeParse(input).success).toBe(false);
    expect(ZSemogDraftRequest.safeParse({ ...input, versao: 0 }).success).toBe(false);
  });
  it('rejects CC/VIEWER fields, assistant signature, missing signer signature and excessive bytes', async () => {
    const input = await draftFixture();
    for (const role of ['CC', 'VIEWER', 'ASSISTANT']) {
      expect(ZSemogDraftRequest.safeParse({ ...input, signatarios: [{ ...input.signatarios[0], role }] }).success).toBe(
        false,
      );
    }
    expect(
      ZSemogDraftRequest.safeParse({ ...input, signatarios: [{ ...input.signatarios[0], campos: [] }] }).success,
    ).toBe(false);
    await expect(validateSemogDraft(input, 5)).rejects.toMatchObject({ statusCode: 413 });
    expect(() => semogDraftMaximum(101 * 1024 * 1024)).toThrow();
  });
});
