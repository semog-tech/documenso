import { describe, expect, it } from 'vitest';

import { createSemogSigningHandler } from './http';
import { createSemogSigningService } from './service';
import { serviceFixture } from './service-test-fixtures';

const request = (body: unknown, options: { authorization?: string; contentType?: string } = {}) =>
  new Request('https://example.org/api/semog/v1/manifestacoes', {
    method: 'POST',
    headers: {
      Authorization: options.authorization ?? 'Bearer test',
      'Content-Type': options.contentType ?? 'application/json',
    },
    body: JSON.stringify(body),
  });

describe('Semog native HTTP adapter', () => {
  it('denies disabled service before auth and parsing', async () => {
    const fixture = serviceFixture();
    const handler = createSemogSigningHandler(createSemogSigningService({ ...fixture.dependencies, enabled: false }));
    const response = await handler(request({ invalid: true }));
    expect(response.status).toBe(503);
    expect(fixture.authenticate).not.toHaveBeenCalled();
  });
  it('authenticates before malformed JSON and rejects missing bearer without provider call', async () => {
    const fixture = serviceFixture();
    const handler = createSemogSigningHandler(fixture.service);
    const response = await handler(
      new Request('https://example.org/api/semog/v1/manifestacoes', { method: 'POST', body: '{' }),
    );
    expect(response.status).toBe(401);
    expect(fixture.authenticate).not.toHaveBeenCalled();
    expect(fixture.readCurrent).not.toHaveBeenCalled();
  });
  it('returns exact pending bridge contract with no-store', async () => {
    const fixture = serviceFixture();
    const response = await createSemogSigningHandler(fixture.service)(request(fixture.input));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      chaveOperacao: fixture.input.chaveOperacao,
      envelopeId: 'env',
      recipientId: 10,
      hashDocumento: fixture.input.hashDocumento,
      hashConsentimento: fixture.input.hashConsentimento,
      acao: 'assinar',
      situacao: 'pendente',
      documentoConcluido: false,
      pdfDisponivel: false,
    });
  });
  it('consults only the authenticated team and requires an operation UUID', async () => {
    const fixture = serviceFixture();
    const handler = createSemogSigningHandler(fixture.service);
    const response = await handler(
      new Request(`https://example.org/api/semog/v1/manifestacoes/${fixture.input.chaveOperacao}`, {
        headers: { Authorization: 'Bearer test' },
      }),
    );
    expect(response.status).toBe(404);
    expect(fixture.repository.getOperation).toHaveBeenCalledWith({
      teamId: 1,
      chaveOperacao: fixture.input.chaveOperacao,
    });
    const bad = await handler(
      new Request('https://example.org/api/semog/v1/manifestacoes/not-a-uuid', {
        headers: { Authorization: 'Bearer test' },
      }),
    );
    expect(bad.status).toBe(400);
  });
  it('caps streamed bodies even without content-length before reading envelope', async () => {
    const fixture = serviceFixture();
    const response = await createSemogSigningHandler(fixture.service)(request({ huge: 'x'.repeat(65537) }));
    expect(response.status).toBe(413);
    expect(fixture.readCurrent).not.toHaveBeenCalled();
    expect(fixture.repository.reserveOperation).not.toHaveBeenCalled();
  });
  it('sanitizes upstream failures and rejects wrong content type', async () => {
    const fixture = serviceFixture();
    const handler = createSemogSigningHandler(fixture.service);
    expect((await handler(request(fixture.input, { contentType: 'text/plain' }))).status).toBe(400);
    fixture.readCurrent.mockRejectedValue(new Error('private-token private-reference'));
    const failure = await handler(request(fixture.input));
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('private');
    fixture.readCurrent.mockRejectedValue(new TypeError('database driver unavailable'));
    expect((await handler(request(fixture.input))).status).toBe(503);
  });
});
