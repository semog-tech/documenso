import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDF } from '@libpdf/core';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { semogPartialSealLabel } from './partial-seal-contract';
import { createSemogPartialSealHandler } from './partial-seal-http';
import {
  buildSemogTestPdf,
  createSemogPartialSealFixture,
  SEMOG_PARTIAL_SEAL_KEY,
  SEMOG_PARTIAL_SEAL_NOW,
  SEMOG_REPOSITORY_ROOT,
} from './partial-seal-test-fixtures';
import { stampSemogPartialSeal } from './sealing';

const body = { rodada: 1, chaveOperacao: SEMOG_PARTIAL_SEAL_KEY };
const stamp = 'SELO PARCIAL · 2 de 5 · 29/10/2026';
/** pdf.js reads form XObjects (the native field overlays) and rotated text, which @libpdf extractText does not. */
const pageTexts = async (bytes: Uint8Array) => {
  const document = await getDocument({ data: new Uint8Array(bytes) }).promise;
  const texts: string[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const content = await (await document.getPage(number)).getTextContent();
    texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
  }
  await document.destroy();
  return texts;
};
const compact = (text: string) => text.replace(/\s+/g, ' ');
const occurrences = (text: string, needle: string) => compact(text).split(needle).length - 1;

describe('Semog partial seal label', () => {
  it('uses the America/Recife calendar day, not UTC', () => {
    // 01:30Z on the 30th is still the 29th in Recife (UTC-3).
    expect(semogPartialSealLabel(2, 5, SEMOG_PARTIAL_SEAL_NOW)).toBe(stamp);
    expect(semogPartialSealLabel(0, 3, new Date('2026-01-05T12:00:00.000Z'))).toBe(
      'SELO PARCIAL · 0 de 3 · 05/01/2026',
    );
  });
});

describe('Semog partial seal stamp', () => {
  it('draws the label on every page of a real PDF', async () => {
    const original = await buildSemogTestPdf();
    expect((await pageTexts(original)).join('')).not.toContain('SELO PARCIAL');
    const pdf = await PDF.load(original);
    stampSemogPartialSeal(
      pdf,
      readFileSync(resolve(SEMOG_REPOSITORY_ROOT, 'apps/remix/public/fonts/noto-sans.ttf')),
      stamp,
    );
    const texts = await pageTexts(await pdf.save());
    expect(texts).toHaveLength(2);
    expect(texts[1]).toBe(stamp);
    expect(texts[0]).toContain(stamp);
  });
});

describe('Semog partial seal of a PENDING envelope (2 of 5)', () => {
  const cwd = process.cwd;
  let fixture: Awaited<ReturnType<typeof createSemogPartialSealFixture>>;
  let result: Awaited<ReturnType<typeof fixture.service.create>>;
  let sealed: Uint8Array;
  beforeAll(async () => {
    // Native renderers resolve fonts and the logo from the remix app directory.
    vi.spyOn(process, 'cwd').mockReturnValue(resolve(SEMOG_REPOSITORY_ROOT, 'apps/remix'));
    fixture = await createSemogPartialSealFixture();
    result = await fixture.service.create(fixture.actor, 'env_partial', body);
    sealed = await fixture.service.pdf(fixture.actor, 'env_partial', 1);
  }, 60000);
  afterAll(() => {
    process.cwd = cwd;
    vi.restoreAllMocks();
  });

  it('returns the round receipt listing all five signers', () => {
    expect(result).toEqual({
      chaveOperacao: SEMOG_PARTIAL_SEAL_KEY,
      envelopeId: 'env_partial',
      rodada: 1,
      hashPdf: createHash('sha256').update(sealed).digest('hex'),
      assinados: 2,
      total: 5,
      assinantes: [
        {
          recipientId: 1,
          nome: 'Ana Conselheira',
          email: 'ana@example.org',
          assinou: true,
          assinadoEm: '2026-10-25T13:00:00.000Z',
        },
        {
          recipientId: 2,
          nome: 'Bruno Conselheiro',
          email: 'bruno@example.org',
          assinou: true,
          assinadoEm: '2026-10-25T13:00:00.000Z',
        },
        { recipientId: 3, nome: 'Carla Conselheira', email: 'carla@example.org', assinou: false, assinadoEm: null },
        { recipientId: 4, nome: 'Diego Conselheiro', email: 'diego@example.org', assinou: false, assinadoEm: null },
        { recipientId: 5, nome: 'Elisa Conselheira', email: 'elisa@example.org', assinou: false, assinadoEm: null },
      ],
      criadoEm: '2026-10-30T01:30:00.123Z',
    });
  });

  it('draws only the two signers fields and stamps every page, certificate included', async () => {
    const texts = await pageTexts(sealed);
    expect(texts.length).toBeGreaterThan(2);
    for (const text of texts) {
      expect(text).toContain(stamp);
    }
    expect(texts[0]).toContain('VALOR-1');
    expect(texts[0]).toContain('VALOR-2');
    expect(texts.join('\n')).not.toContain('NAO-ASSINOU');
  });

  it('lists all five in the certificate and marks the three who did not sign', async () => {
    const certificate = (await pageTexts(sealed)).slice(2).join('\n');
    for (const name of [
      'Ana Conselheira',
      'Bruno Conselheiro',
      'Carla Conselheira',
      'Diego Conselheiro',
      'Elisa Conselheira',
    ]) {
      expect(compact(certificate)).toContain(name);
    }
    // The native "I am a signer" reason would claim approval: only the two signers may carry it.
    expect(occurrences(certificate, 'I am a signer of this document')).toBe(2);
    expect(occurrences(certificate, 'Não assinou')).toBe(3);
    expect(occurrences(certificate, 'selo parcial 2 de 5')).toBe(3);
    // Non-signers must not get the native empty signature box with a signature ID.
    expect(certificate).toContain('FIELD1SIG');
    expect(certificate).toContain('FIELD2SIG');
    for (const id of ['FIELD3SIG', 'FIELD4SIG', 'FIELD5SIG']) {
      expect(certificate).not.toContain(id);
    }
  });

  it('signs with the platform certificate (CAdES detached)', () => {
    const contents = Buffer.from(sealed).toString('latin1');
    expect(contents).toContain('/ETSI.CAdES.detached');
    expect(contents).toContain('/ByteRange');
  });

  it('keeps the envelope PENDING and the native document untouched', () => {
    expect(fixture.envelope.status).toBe('PENDING');
    expect(fixture.envelope.completedAt).toBeNull();
    expect(fixture.envelope.envelopeItems[0].documentDataId).toBe('data_original');
    expect(fixture.store.tx.envelope.update).not.toHaveBeenCalled();
    expect(fixture.store.tx.envelope.updateMany).not.toHaveBeenCalled();
    expect(fixture.store.tx.envelopeItem.update).not.toHaveBeenCalled();
    expect(fixture.store.tx.recipient.update).not.toHaveBeenCalled();
    expect(fixture.store.tx.documentAuditLog.create).not.toHaveBeenCalled();
    // The only write besides the new DocumentData: no outbox, no DOCUMENT_COMPLETED.
    expect(fixture.store.state.executed).toHaveLength(1);
    expect(fixture.store.state.executed[0]).toContain('INSERT INTO semog_bridge.partial_seals');
    expect(fixture.store.transactions[0]).toMatchObject({ isolationLevel: 'Serializable' });
  });

  it('replays the same round without rendering again', async () => {
    const again = await fixture.service.create(fixture.actor, 'env_partial', body);
    expect(again).toEqual(result);
    expect(fixture.store.tx.documentData.create).toHaveBeenCalledTimes(1);
    expect(fixture.getDocumentI18n).toHaveBeenCalledTimes(1);
  });

  it('rejects a key reused for another round or another key for the same round', async () => {
    await expect(fixture.service.create(fixture.actor, 'env_partial', { ...body, rodada: 2 })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      fixture.service.create(fixture.actor, 'env_partial', {
        ...body,
        chaveOperacao: '0f0d2b6c-7c44-4d0e-9a39-0ad8c3f0d8a1',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('Semog partial seal refusals', () => {
  const refuse = async (
    change: (fixture: Awaited<ReturnType<typeof createSemogPartialSealFixture>>) => void,
    status: number,
    actor = { teamId: 1, userId: 9 },
  ) => {
    const fixture = await createSemogPartialSealFixture();
    change(fixture);
    await expect(fixture.service.create(actor, 'env_partial', body)).rejects.toMatchObject({ statusCode: status });
    expect(fixture.store.tx.documentData.create).not.toHaveBeenCalled();
    expect(fixture.store.state.partialSeals).toHaveLength(0);
  };
  it('refuses an envelope that is not PENDING', async () => {
    await refuse((fixture) => Object.assign(fixture.envelope, { status: 'COMPLETED' }), 409);
  });
  it('refuses an envelope with a REJECTED recipient', async () => {
    await refuse((fixture) => Object.assign(fixture.envelope.recipients[3], { signingStatus: 'REJECTED' }), 409);
  });
  it('refuses another team without revealing the envelope', async () => {
    await refuse(() => undefined, 404, { teamId: 2, userId: 9 });
  });
  it('refuses envelopes the bridge did not activate', async () => {
    await refuse((fixture) => Object.assign(fixture.store.state, { managed: false }), 404);
  });
  it('refuses legacy or non-SES envelopes', async () => {
    await refuse((fixture) => Object.assign(fixture.envelope, { internalVersion: 1 }), 409);
    await refuse((fixture) => Object.assign(fixture.envelope, { signatureLevel: 'AES' }), 409);
  });
  it('refuses when everyone signed: the native full seal owns that document', async () => {
    await refuse((fixture) => {
      for (const recipient of fixture.envelope.recipients) {
        Object.assign(recipient, { signingStatus: 'SIGNED' });
      }
    }, 409);
  });
  it('refuses malformed bodies before any transaction', async () => {
    const fixture = await createSemogPartialSealFixture();
    for (const invalid of [
      {},
      { rodada: 0, chaveOperacao: SEMOG_PARTIAL_SEAL_KEY },
      { rodada: 1.5, chaveOperacao: SEMOG_PARTIAL_SEAL_KEY },
      { rodada: '1', chaveOperacao: SEMOG_PARTIAL_SEAL_KEY },
      { rodada: 1, chaveOperacao: 'not-a-uuid' },
      { ...body, teamId: 2 },
    ]) {
      await expect(fixture.service.create(fixture.actor, 'env_partial', invalid)).rejects.toThrow();
    }
    expect(fixture.store.transactions).toHaveLength(0);
  });
  it('is unavailable when disabled, before authentication or any transaction', async () => {
    const fixture = await createSemogPartialSealFixture({ enabled: false });
    await expect(fixture.service.authenticate('api_0123456789abcdef')).rejects.toMatchObject({ statusCode: 503 });
    await expect(fixture.service.create(fixture.actor, 'env_partial', body)).rejects.toMatchObject({ statusCode: 503 });
    await expect(fixture.service.pdf(fixture.actor, 'env_partial', 1)).rejects.toMatchObject({ statusCode: 503 });
    expect(fixture.authenticate).not.toHaveBeenCalled();
    expect(fixture.store.transactions).toHaveLength(0);
  });
});

describe('Semog partial seal HTTP boundary', () => {
  const base = 'https://local.invalid/api/semog/v1/envelopes/env_partial/selos-parciais';
  const post = (payload: string, headers: Record<string, string> = {}) =>
    new Request(base, {
      method: 'POST',
      headers: { authorization: 'Bearer api_0123456789abcdef', 'content-type': 'application/json', ...headers },
      body: payload,
    });
  const service = () => ({
    authenticate: vi.fn(async () => ({ teamId: 1, userId: 9 })),
    create: vi.fn(async () => ({
      chaveOperacao: SEMOG_PARTIAL_SEAL_KEY,
      envelopeId: 'env_partial',
      rodada: 1,
      hashPdf: 'a'.repeat(64),
      assinados: 0,
      total: 1,
      assinantes: [{ recipientId: 1, nome: 'Ana', email: 'ana@example.org', assinou: false, assinadoEm: null }],
      criadoEm: '2026-10-30T01:30:00.123Z',
    })),
    pdf: vi.fn(async () => new TextEncoder().encode('%PDF-partial')),
  });
  it('requires a bearer, JSON and a bounded body before invoking the seal', async () => {
    const fake = service();
    const handler = createSemogPartialSealHandler(fake);
    expect((await handler(post(JSON.stringify(body), { authorization: '' }))).status).toBe(401);
    expect((await handler(post(JSON.stringify(body), { 'content-type': 'text/plain' }))).status).toBe(400);
    expect((await handler(post('{'))).status).toBe(400);
    expect((await handler(post('x'.repeat(4097)))).status).toBe(413);
    expect(fake.create).not.toHaveBeenCalled();
    const accepted = await handler(post(JSON.stringify(body)));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(fake.create).toHaveBeenCalledWith({ teamId: 1, userId: 9 }, 'env_partial', body);
  });
  it('maps validation errors to 400 and sanitizes native failures', async () => {
    const fake = service();
    fake.create.mockRejectedValueOnce(new Error('private database secret'));
    const handler = createSemogPartialSealHandler(fake);
    const failed = await handler(post(JSON.stringify(body)));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private');
  });
  it('serves the round PDF with its hash and refuses unknown paths', async () => {
    const fake = service();
    const handler = createSemogPartialSealHandler(fake);
    const response = await handler(
      new Request(`${base}/3/pdf`, { headers: { authorization: 'Bearer api_0123456789abcdef' } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('x-documento-sha256')).toBe(createHash('sha256').update('%PDF-partial').digest('hex'));
    expect(fake.pdf).toHaveBeenCalledWith({ teamId: 1, userId: 9 }, 'env_partial', 3);
    for (const path of [`${base}/0/pdf`, `${base}/abc/pdf`, `${base}/1`, `${base}/1/pdf/extra`]) {
      const refused = await handler(new Request(path, { headers: { authorization: 'Bearer api_0123456789abcdef' } }));
      expect(refused.status).toBe(404);
    }
    expect((await handler(new Request(base, { headers: { authorization: 'Bearer x' } }))).status).toBe(404);
  });
  it('reads the stored PDF only for the owning team and verifies its hash', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(resolve(SEMOG_REPOSITORY_ROOT, 'apps/remix'));
    const fixture = await createSemogPartialSealFixture();
    await expect(fixture.service.pdf(fixture.actor, 'env_partial', 1)).rejects.toMatchObject({ statusCode: 404 });
    await fixture.service.create(fixture.actor, 'env_partial', body);
    await expect(fixture.service.pdf({ teamId: 2, userId: 9 }, 'env_partial', 1)).rejects.toMatchObject({
      statusCode: 404,
    });
    const row = fixture.store.state.partialSeals[0];
    const stored = fixture.store.state.documentData.get(row.documentDataId);
    if (!stored) {
      throw new Error('missing stored seal');
    }
    stored.data = Buffer.from('%PDF-tampered').toString('base64');
    await expect(fixture.service.pdf(fixture.actor, 'env_partial', 1)).rejects.toMatchObject({ statusCode: 409 });
    vi.restoreAllMocks();
  }, 60000);
});
