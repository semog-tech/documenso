import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { SemogDraftResult } from './draft-contract';
import { createSemogDraftHandler, SEMOG_DRAFT_PATH } from './draft-http';
import { createSemogDraftService } from './draft-service';
import { validateSemogBinaryDraft, validateSemogDraft } from './draft-validation';
import type { SemogPdfStore } from './pdf-store';
import type { SemogStageTiming } from './timing';

const fixture = async () => {
  const document = await PDFDocument.create();
  document.addPage();
  const bytes = await document.save();
  const input = {
    operacaoId: randomUUID(),
    externalId: randomUUID(),
    versao: 1,
    ordemAssinatura: 'paralela',
    titulo: 'Teste local',
    arquivo: {
      nome: 'local.pdf',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      pdfBase64: Buffer.from(bytes).toString('base64'),
    },
    signatarios: [
      {
        referencia: randomUUID(),
        nome: 'Teste local',
        email: 'teste@example.invalid',
        ordem: 0,
        role: 'SIGNER',
        campos: [
          {
            referencia: randomUUID(),
            tipo: 'SIGNATURE',
            papel: 'assinatura',
            pagina: 1,
            x: 10,
            y: 10,
            largura: 20,
            altura: 10,
            obrigatorio: true,
          },
        ],
      },
    ],
  };
  return { bytes, input };
};
const request = (body: BodyInit, contentType = 'application/json') =>
  new Request(`https://bridge.invalid${SEMOG_DRAFT_PATH}`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': contentType },
    body,
    duplex: 'half',
  } as RequestInit);
const assertSafe = (timings: SemogStageTiming[]) => {
  for (const timing of timings) {
    expect(Object.keys(timing).every((key) => ['stage', 'ms', 'ok', 'bytes'].includes(key))).toBe(true);
    expect(timing.ms).toBeGreaterThanOrEqual(0);
  }
};

describe('Draft timing is observational', () => {
  it('buffers the complete body before storage and measures through response construction even if telemetry throws', async () => {
    const { bytes, input } = await fixture();
    const timings: SemogStageTiming[] = [];
    let ended = false;
    let stored: Uint8Array = new Uint8Array();
    const store: SemogPdfStore = {
      write(_key, value) {
        expect(ended).toBe(true);
        stored = value;
        return Promise.resolve();
      },
      read() {
        expect(this).toBe(store);
        return Promise.resolve(stored);
      },
      exists() {
        expect(this).toBe(store);
        return Promise.resolve(true);
      },
    };
    const result = { envelopeId: 'local' };
    // Stand-in transaction returns the committed result without executing a Prisma callback.
    const transaction = <T>(): Promise<T> => Promise.resolve(result as unknown as T);
    const observe = (timing: SemogStageTiming) => {
      timings.push(timing);
      throw new Error('telemetry unavailable');
    };
    const service = createSemogDraftService({
      enabled: true,
      client: { $transaction: transaction },
      authenticate: async () => ({ teamId: 1, userId: 1 }),
      pdfStore: store,
      observe,
    });
    const body = Buffer.from(JSON.stringify(input));
    let chunk = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (chunk === 0) {
            controller.enqueue(body.subarray(0, 10));
          } else if (chunk === 1) {
            controller.enqueue(body.subarray(10));
          } else {
            ended = true;
            controller.close();
          }
          chunk++;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await createSemogDraftHandler(service, observe)(request(stream));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(Buffer.from(stored)).toEqual(Buffer.from(bytes));
    expect(timings).toContainEqual({ stage: 'draft.body', ms: expect.any(Number), ok: true, bytes: body.byteLength });
    expect(timings.map(({ stage }) => stage)).toEqual([
      'draft.authenticate',
      'draft.body',
      'draft.parse.json',
      'draft.validate.schema',
      'draft.decode.base64',
      'draft.hash',
      'draft.pdf-load',
      'draft.request-hash',
      'draft.validate',
      'draft.storage.write',
      'draft.storage.read',
      'draft.storage',
      'draft.transaction',
      'draft.storage.head',
      'draft.confirm',
      'draft.response',
      'draft.total',
    ]);
    assertSafe(timings);
  });

  it('reports failures before the sanitized HTTP response, preserving storage errors', async () => {
    const { input } = await fixture();
    const original = new Error('private failure');
    const timings: SemogStageTiming[] = [];
    const observe = (timing: SemogStageTiming) => {
      timings.push(timing);
      throw new Error('telemetry unavailable');
    };
    const write = vi.fn(() => Promise.reject(original));
    const service = createSemogDraftService({
      enabled: true,
      client: { $transaction: vi.fn() },
      authenticate: async () => ({ teamId: 1, userId: 1 }),
      pdfStore: { write, read: vi.fn() },
      observe,
    });
    await expect(service.create({ teamId: 1, userId: 1 }, input)).rejects.toBe(original);
    timings.length = 0;
    const response = await createSemogDraftHandler(service, observe)(request(JSON.stringify(input)));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
    expect(timings.slice(-3).map(({ stage, ok }) => ({ stage, ok }))).toEqual([
      { stage: 'draft.storage.write', ok: false },
      { stage: 'draft.storage', ok: false },
      { stage: 'draft.total', ok: false },
    ]);
    assertSafe(timings);
  });

  it('measures multipart parsing without a base64 stage', async () => {
    const { bytes, input } = await fixture();
    const { pdfBase64: _base64, ...arquivo } = input.arquivo;
    const metadata = { ...input, arquivo: { ...arquivo, tamanho: bytes.byteLength } };
    const timings: SemogStageTiming[] = [];
    const observe = (timing: SemogStageTiming) => {
      timings.push(timing);
    };
    const service = createSemogDraftService({
      enabled: true,
      // No database callback is needed to establish the parsing/validation boundary.
      client: { $transaction: <T>() => Promise.resolve({} as T) },
      authenticate: async () => ({ teamId: 1, userId: 1 }),
      observe,
    });
    const body = Buffer.concat([
      Buffer.from(
        `--local\r\nContent-Disposition: form-data; name="metadados"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--local\r\nContent-Disposition: form-data; name="arquivo"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from('\r\n--local--\r\n'),
    ]);
    expect(
      (await createSemogDraftHandler(service, observe)(request(body, 'multipart/form-data; boundary=local'))).status,
    ).toBe(200);
    expect(timings).toContainEqual({
      stage: 'draft.parse.multipart',
      ok: true,
      ms: expect.any(Number),
      bytes: bytes.byteLength,
    });
    expect(timings.some(({ stage }) => stage === 'draft.decode.base64')).toBe(false);
    assertSafe(timings);
  });

  it('measures the real native callback, replay, commit and commit failure', async () => {
    const { input } = await fixture();
    const actor = { teamId: 1, userId: 1 };
    const timings: SemogStageTiming[] = [];
    const observe = (timing: SemogStageTiming) => {
      timings.push(timing);
      throw new Error('telemetry unavailable');
    };
    const validated = await validateSemogDraft(input, 50000);
    let receipt: { teamId: number; userId: number; hash: string; resultado: SemogDraftResult } | undefined;
    let commitFailure: Error | undefined;
    const events: string[] = [];
    const createEnvelope = vi.fn(() =>
      Promise.resolve({ id: 'envelope_local', envelopeItems: [{ id: 'item_local' }] }),
    );
    const executeRaw = vi.fn(() => Promise.resolve(1));
    const audit = vi.fn(() => Promise.resolve({ id: 1 }));
    // Narrow Prisma stand-in: only the methods actually exercised by the real draft callback exist.
    const tx = {
      user: { findFirst: () => Promise.resolve({ id: 1 }) },
      team: { findFirst: () => Promise.resolve({ id: 1 }) },
      $queryRaw: (sql: Prisma.Sql) => Promise.resolve(sql.sql.includes('draft_receipts') && receipt ? [receipt] : []),
      $executeRaw: executeRaw,
      counter: { update: () => Promise.resolve({ value: 1 }) },
      documentData: { create: () => Promise.resolve({ id: 'data_local' }) },
      envelope: {
        create: createEnvelope,
        findUniqueOrThrow: () => Promise.resolve({ recipients: [], fields: [], envelopeItems: [] }),
      },
      recipient: { create: () => Promise.resolve({ id: 1 }) },
      field: { create: () => Promise.resolve({ id: 1 }) },
      documentAuditLog: { create: audit },
    } as unknown as Prisma.TransactionClient;
    const client = {
      $transaction: async <T>(callback: (transaction: Prisma.TransactionClient) => Promise<T>) => {
        const result = await callback(tx);
        events.push('callback-complete');
        expect(timings.some(({ stage }) => stage === 'draft.transaction')).toBe(false);
        if (commitFailure) {
          throw commitFailure;
        }
        events.push('commit-complete');
        return result;
      },
    };
    const service = createSemogDraftService({
      enabled: true,
      client,
      authenticate: () => Promise.resolve(actor),
      observe,
    });
    const result = await service.create(actor, input);
    expect(result).toMatchObject({ envelopeId: 'envelope_local', documento: { itemId: 'item_local' } });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['callback-complete', 'commit-complete']);
    expect(timings.slice(6).map(({ stage }) => stage)).toEqual([
      'draft.storage',
      'draft.actor',
      'draft.lock',
      'draft.replay',
      'draft.document',
      'draft.envelope-items',
      'draft.recipients-fields',
      'draft.audit',
      'draft.native',
      'draft.receipt',
      'draft.transaction',
    ]);
    expect(timings.at(-1)).toMatchObject({ stage: 'draft.transaction', ok: true });
    receipt = { ...actor, hash: validated.hash, resultado: result };
    timings.length = 0;
    expect(await service.create(actor, input)).toEqual(result);
    expect(createEnvelope).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(timings.some(({ stage }) => stage === 'draft.native')).toBe(false);
    expect(timings.at(-1)).toMatchObject({ stage: 'draft.transaction', ok: true });
    timings.length = 0;
    commitFailure = new Error('commit refused');
    await expect(service.create(actor, input)).rejects.toBe(commitFailure);
    expect(timings.at(-1)).toEqual({ stage: 'draft.transaction', ms: expect.any(Number), ok: false });
    assertSafe(timings);
  });

  it('locates schema, base64, hash and PDF refusals without exposing payloads', async () => {
    const { input, bytes } = await fixture();
    const timings: SemogStageTiming[] = [];
    const observe = (timing: SemogStageTiming) => {
      timings.push(timing);
    };
    for (const [body, stage] of [
      [{}, 'draft.validate.schema'],
      [{ ...input, arquivo: { ...input.arquivo, pdfBase64: '____' } }, 'draft.decode.base64'],
      [{ ...input, arquivo: { ...input.arquivo, sha256: '0'.repeat(64) } }, 'draft.hash'],
      [
        {
          ...input,
          arquivo: {
            ...input.arquivo,
            pdfBase64: Buffer.from('invalid PDF').toString('base64'),
            sha256: createHash('sha256').update('invalid PDF').digest('hex'),
          },
        },
        'draft.pdf-load',
      ],
    ] as const) {
      timings.length = 0;
      await expect(validateSemogDraft(body, 50000, observe)).rejects.toBeDefined();
      expect(timings.at(-1)).toEqual({ stage, ok: false, ms: expect.any(Number) });
      assertSafe(timings);
    }
    const { pdfBase64: _inline, ...arquivo } = input.arquivo;
    timings.length = 0;
    await expect(
      validateSemogBinaryDraft(
        { ...input, arquivo: { ...arquivo, tamanho: bytes.byteLength, sha256: '0'.repeat(64) } },
        bytes,
        50000,
        observe,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(timings.at(-1)).toMatchObject({ stage: 'draft.hash', ok: false });
  });
});
