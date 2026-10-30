import { describe, expect, it } from 'vitest';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { executionFixture, pdfWithPages, sealedLikePdf } from './execution-test-fixtures';
import type { SemogStageTiming } from './timing';

const timeout = () => new Error('Transaction API error: Transaction already closed (simulado)');
const base64Of = async (pages: number) => Buffer.from(await pdfWithPages(pages)).toString('base64');

/** Reserva a chave e derruba a transação uma vez, como no estouro de prazo de #638. */
const reserveAndFailOnce = async (fixture: Awaited<ReturnType<typeof executionFixture>>) => {
  fixture.state.beforeSerializable = () => {
    fixture.state.beforeSerializable = undefined;
    throw timeout();
  };
  await expect(fixture.service.reserve(fixture.actor, fixture.input)).rejects.toThrow('simulado');
  expect(fixture.state.operation?.estado).toBe('pendente');
  fixture.state.pdfReads = 0;
};

describe('PDF da manifestação fora da transação Serializable', () => {
  it('lê o PDF uma única vez por manifestação e nunca dentro da transação', async () => {
    const fixture = await executionFixture();
    const result = await fixture.service.reserve(fixture.actor, fixture.input);
    expect(result).toMatchObject({ situacao: 'concluida', acao: 'assinar' });
    expect(fixture.state.pdfReads).toBe(1);
    expect(fixture.readCurrent).toHaveBeenCalledTimes(1);
    expect(fixture.state.serializableRuns).toBe(1);
    expect(fixture.state.writes).toBeGreaterThan(0);
  });

  it('repetição de chave reservada lê o PDF uma vez, pelo próprio executor, fora da transação', async () => {
    const fixture = await executionFixture();
    await reserveAndFailOnce(fixture);
    const result = await fixture.service.reserve(fixture.actor, fixture.input);
    expect(result.situacao).toBe('concluida');
    expect(fixture.state.pdfReads).toBe(1);
    expect(fixture.readCurrent).toHaveBeenCalledTimes(1);
  });

  it('chaveOperacao concluída devolve o mesmo resultado sem reler o PDF nem gravar de novo', async () => {
    const fixture = await executionFixture();
    const first = await fixture.service.reserve(fixture.actor, fixture.input);
    const writes = fixture.state.writes;
    fixture.state.pdfReads = 0;
    fixture.state.pdfBudget = 0;
    expect(await fixture.service.reserve(fixture.actor, fixture.input)).toEqual(first);
    expect(fixture.state.writes).toBe(writes);
    await expect(
      fixture.service.reserve(fixture.actor, { ...fixture.input, campos: [{ fieldId: 20, valor: 'Outro' }] }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.state.writes).toBe(writes);
    expect(fixture.state.pdfReads).toBe(0);
  });

  it('recusa PDF cujo hash não é o do snapshot, na reserva e na repetição', async () => {
    const atReservation = await executionFixture();
    atReservation.state.documentData.initialData = await base64Of(2);
    await expect(atReservation.service.reserve(atReservation.actor, atReservation.input)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(atReservation.state.operation).toBeNull();
    expect(atReservation.state.serializableRuns).toBe(0);

    const atReplay = await executionFixture();
    await reserveAndFailOnce(atReplay);
    atReplay.state.documentData.initialData = await base64Of(2);
    await expect(atReplay.service.reserve(atReplay.actor, atReplay.input)).rejects.toMatchObject({ statusCode: 409 });
    expect(atReplay.state.writes).toBe(0);
    expect(atReplay.state.operation?.estado).toBe('pendente');
  });

  it('recusa quando o envelope muda entre a leitura do PDF e a transação', async () => {
    const cases: ((state: Awaited<ReturnType<typeof executionFixture>>['state']) => void)[] = [
      (state) => {
        state.documentData = { ...state.documentData, id: 'data-2' };
        state.envelope.envelopeItems[0] = { ...state.envelope.envelopeItems[0], documentDataId: 'data-2' };
      },
      // Same DocumentData row, other bytes: only the INITIAL_DATA digest computed by the database sees it.
      (state) => {
        state.documentData.initialData = `${state.documentData.initialData.slice(0, -4)}AAAA`;
      },
      (state) => {
        state.envelope.recipients[0] = { ...state.envelope.recipients[0], email: 'outro@example.org' };
      },
    ];
    for (const change of cases) {
      const fixture = await executionFixture();
      fixture.state.beforeSerializable = () => change(fixture.state);
      await expect(fixture.service.reserve(fixture.actor, fixture.input)).rejects.toMatchObject({ statusCode: 409 });
      expect(fixture.state.writes).toBe(0);
      expect(fixture.state.operation?.estado).toBe('pendente');
      expect(fixture.state.pdfReads).toBe(1);
    }
  });

  it('registra a duração de cada etapa sem dado de pessoa ou documento', async () => {
    const timings: SemogStageTiming[] = [];
    const fixture = await executionFixture({ observe: (timing) => timings.push(timing) });
    await fixture.service.reserve(fixture.actor, fixture.input);
    expect(timings.map((timing) => timing.stage)).toEqual([
      'reserve.read',
      'reserve.snapshot',
      'execute.pdf',
      'execute.transaction',
      'manifestation',
    ]);
    for (const timing of timings) {
      expect(Object.keys(timing).every((key) => ['stage', 'ms', 'ok', 'bytes', 'attempts'].includes(key))).toBe(true);
      expect(timing.ok).toBe(true);
    }
    expect(timings.find((timing) => timing.stage === 'execute.transaction')?.attempts).toBe(1);
    expect(timings.find((timing) => timing.stage === 'reserve.read')?.bytes).toBe(fixture.pdf.byteLength);
  });

  it('a contagem de páginas do parse completo continua barrando campo fora do documento', async () => {
    const fixture = await executionFixture({ fieldPage: 2 });
    await expect(fixture.service.reserve(fixture.actor, fixture.input)).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.state.writes).toBe(0);
  });
});

describe('Erro adiado da leitura fora da transação', () => {
  it('a falha real da leitura do PDF chega ao chamador, no ponto em que a leitura antiga falharia', async () => {
    const fixture = await executionFixture({ storage: 'S3_PATH' });
    await reserveAndFailOnce(fixture);
    fixture.state.storeReadFailure = new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
    await expect(fixture.service.reserve(fixture.actor, fixture.input)).rejects.toMatchObject({ statusCode: 503 });
    expect(fixture.state.writes).toBe(0);
  });
  it('recusas que vinham antes da leitura continuam vindo antes: inscrição revogada vence a falha do armazenamento', async () => {
    const fixture = await executionFixture({ storage: 'S3_PATH' });
    await reserveAndFailOnce(fixture);
    fixture.state.storeReadFailure = new AppError(AppErrorCode.NOT_SETUP, { statusCode: 503 });
    fixture.state.snapshotActive = false;
    await expect(fixture.service.reserve(fixture.actor, fixture.input)).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.state.writes).toBe(0);
  });
});

describe('PDF no armazenamento de objetos (S3_PATH, chave por hash)', () => {
  it('assina lendo o objeto uma única vez, fora da transação', async () => {
    const fixture = await executionFixture({ storage: 'S3_PATH' });
    expect(fixture.state.documentData.initialData).toMatch(/^semog\/pdf\/[a-f0-9]{64}\.pdf$/);
    expect((await fixture.service.reserve(fixture.actor, fixture.input)).situacao).toBe('concluida');
    expect(fixture.state.pdfReads).toBe(1);
  });
  it('recusa objeto trocado no bucket: os bytes não batem com o hash da chave', async () => {
    const fixture = await executionFixture({ storage: 'S3_PATH' });
    fixture.objects.set(fixture.state.documentData.initialData, await pdfWithPages(2));
    await expect(fixture.service.reserve(fixture.actor, fixture.input)).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.state.operation).toBeNull();
  });
});

describe('Assinatura concluída: original e selado lidos fora da transação', () => {
  for (const storage of ['BYTES_64', 'S3_PATH'] as const) {
    it(`${storage}: consulta e download leem os dois PDFs antes da transação e devolvem o selado`, async () => {
      const fixture = await executionFixture({ storage });
      await fixture.service.reserve(fixture.actor, fixture.input);
      const sealed = await fixture.markSealed();
      fixture.state.pdfReads = 0;
      fixture.state.pdfBudget = 2;
      const result = await fixture.executor.get(fixture.actor, fixture.input.chaveOperacao);
      expect(result).toMatchObject({ documentoConcluido: true, pdfDisponivel: true });
      expect(fixture.state.pdfReads).toBe(2);
      fixture.state.pdfReads = 0;
      const bytes = await fixture.executor.pdf(fixture.actor, fixture.input.chaveOperacao);
      expect(Buffer.from(bytes).equals(Buffer.from(sealed))).toBe(true);
      fixture.state.pdfReads = 0;
      // Idempotent replay of the concluded key: same answer, no new write.
      const writes = fixture.state.writes;
      expect((await fixture.service.reserve(fixture.actor, fixture.input)).situacao).toBe('concluida');
      expect(fixture.state.writes).toBe(writes);
    });
  }
  it('recusa selado adulterado (objeto trocado ou hash do recibo divergente)', async () => {
    const swapped = await executionFixture({ storage: 'S3_PATH' });
    await swapped.service.reserve(swapped.actor, swapped.input);
    await swapped.markSealed();
    swapped.state.pdfBudget = 10;
    // One extra byte: still a valid sealed-looking PDF, but not the one the key names.
    swapped.objects.set(swapped.state.documentData.data, new Uint8Array([...(await sealedLikePdf()), 32]));
    await expect(swapped.executor.get(swapped.actor, swapped.input.chaveOperacao)).rejects.toMatchObject({
      statusCode: 409,
    });
    const receipt = await executionFixture();
    await receipt.service.reserve(receipt.actor, receipt.input);
    await receipt.markSealed();
    receipt.state.pdfBudget = 10;
    const operation = receipt.state.operation;
    if (!operation) {
      throw new Error('operação não reservada no teste');
    }
    operation.execucao = { selagem: { documentDataId: 'sealed', hashPdf: 'a'.repeat(64) } };
    await expect(receipt.executor.get(receipt.actor, receipt.input.chaveOperacao)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it('recusa INITIAL_DATA trocado entre a leitura e a transação, mesmo com o selado intacto', async () => {
    const fixture = await executionFixture();
    await fixture.service.reserve(fixture.actor, fixture.input);
    await fixture.markSealed();
    fixture.state.pdfBudget = 10;
    fixture.state.beforeSerializable = () => {
      fixture.state.documentData = {
        ...fixture.state.documentData,
        initialData: `${fixture.state.documentData.initialData.slice(0, -4)}AAAA`,
      };
    };
    await expect(fixture.executor.get(fixture.actor, fixture.input.chaveOperacao)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it('recusa DocumentData alterada entre a leitura e a transação', async () => {
    const fixture = await executionFixture();
    await fixture.service.reserve(fixture.actor, fixture.input);
    await fixture.markSealed();
    fixture.state.pdfBudget = 10;
    fixture.state.beforeSerializable = () => {
      fixture.state.documentData = { ...fixture.state.documentData, data: `${fixture.state.documentData.data}AAAA` };
    };
    await expect(fixture.executor.get(fixture.actor, fixture.input.chaveOperacao)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
