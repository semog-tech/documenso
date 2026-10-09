import { describe, expect, it } from 'vitest';

import { createSemogSigningService } from './service';
import { serviceFixture } from './service-test-fixtures';
import { hashSemogManifestation } from './service-validation';
import { buildSemogSnapshot } from './snapshot';

describe('Semog durable reservation service', () => {
  it('reserva após override paralelo editável e bloqueia alteração do default nos metadados', async () => {
    const fixture = serviceFixture();
    const base = {
      ...fixture.envelope,
      recipients: [...fixture.envelope.recipients, { ...fixture.envelope.recipients[0], id: 11, token: 'other-token' }],
      fields: [
        ...fixture.envelope.fields,
        { ...fixture.envelope.fields[0], id: 30, recipientId: 11 },
        {
          ...fixture.envelope.fields[1],
          id: 31,
          recipientId: 11,
          fieldMeta: { type: 'text', text: 'Sugestão', readOnly: false },
          customText: 'Sugestão',
          inserted: true,
        },
      ],
    };
    fixture.repository.getSnapshot.mockResolvedValue(
      buildSemogSnapshot({ ...fixture.enrollment, envelope: base, pdf: fixture.pdf, teamId: 1 }),
    );
    const fields = base.fields.map((field) =>
      field.id === 31 ? { ...field, customText: 'Outra decisão legítima' } : field,
    );
    const service = createSemogSigningService({
      ...fixture.dependencies,
      readCurrent: async () => ({ envelope: { ...base, fields }, pdf: fixture.pdf }),
    });
    expect((await service.reserve(fixture.actor, fixture.input)).situacao).toBe('pendente');
    fixture.repository.reserveOperation.mockClear();
    const modified = fields.map((field) =>
      field.id === 31 ? { ...field, fieldMeta: { type: 'text', text: 'Default adulterado', readOnly: false } } : field,
    );
    const tampered = createSemogSigningService({
      ...fixture.dependencies,
      readCurrent: async () => ({ envelope: { ...base, fields: modified }, pdf: fixture.pdf }),
    });
    await expect(tampered.reserve(fixture.actor, fixture.input)).rejects.toThrow();
    expect(fixture.repository.reserveOperation).not.toHaveBeenCalled();
  });
  it('aceita preenchimento nativo paralelo de defaults e bloqueia substituição do valor autorizado', async () => {
    const fixture = serviceFixture();
    const base = {
      ...fixture.envelope,
      recipients: [...fixture.envelope.recipients, { ...fixture.envelope.recipients[0], id: 11, token: 'other-token' }],
      fields: [
        ...fixture.envelope.fields,
        { ...fixture.envelope.fields[0], id: 30, recipientId: 11 },
        {
          ...fixture.envelope.fields[1],
          id: 31,
          recipientId: 11,
          fieldMeta: { type: 'text', text: 'Valor predefinido', readOnly: true },
          customText: '',
          inserted: false,
        },
      ],
    };
    const snapshot = buildSemogSnapshot({ ...fixture.enrollment, envelope: base, pdf: fixture.pdf, teamId: 1 });
    fixture.repository.getSnapshot.mockResolvedValue(snapshot);
    const fields = base.fields.map((field) =>
      field.id === 31 ? { ...field, customText: 'Valor predefinido', inserted: true } : field,
    );
    const service = createSemogSigningService({
      ...fixture.dependencies,
      readCurrent: async () => ({
        envelope: { ...base, fields },
        pdf: fixture.pdf,
      }),
    });
    expect((await service.reserve(fixture.actor, fixture.input)).situacao).toBe('pendente');
    fixture.repository.reserveOperation.mockClear();
    fields[3].customText = 'Valor adulterado';
    await expect(service.reserve(fixture.actor, fixture.input)).rejects.toThrow();
    expect(fixture.repository.reserveOperation).not.toHaveBeenCalled();
  });
  it('reserva após assinatura paralela alheia sem confundir progresso com edição do documento', async () => {
    const fixture = serviceFixture();
    fixture.envelope.recipients.push({ ...fixture.envelope.recipients[0], id: 11, token: 'other-token' });
    fixture.envelope.fields.push({ ...fixture.envelope.fields[0], id: 30, recipientId: 11 });
    fixture.envelope.fields.push({ ...fixture.envelope.fields[1], id: 31, recipientId: 11 });
    const snapshot = buildSemogSnapshot({
      ...fixture.enrollment,
      envelope: fixture.envelope,
      pdf: fixture.pdf,
      teamId: 1,
    });
    fixture.repository.getSnapshot.mockResolvedValue(snapshot);
    const current = {
      ...fixture.envelope,
      recipients: fixture.envelope.recipients.map((recipient) =>
        recipient.id === 11
          ? {
              ...recipient,
              signingStatus: 'SIGNED',
              signedAt: '2026-10-06T12:00:00Z',
            }
          : recipient,
      ),
      fields: fixture.envelope.fields.map((field) =>
        field.recipientId === 11
          ? {
              ...field,
              inserted: true,
              customText: field.type === 'TEXT' ? 'Parecer alheio' : field.customText,
            }
          : field,
      ),
    };
    const service = createSemogSigningService({
      ...fixture.dependencies,
      readCurrent: async () => ({ envelope: current, pdf: fixture.pdf }),
    });
    expect((await service.reserve(fixture.actor, fixture.input)).situacao).toBe('pendente');
    expect(fixture.repository.reserveOperation).toHaveBeenCalledTimes(1);
    fixture.repository.reserveOperation.mockClear();
    current.recipients[1].email = 'changed@example.org';
    await expect(service.reserve(fixture.actor, fixture.input)).rejects.toThrow();
    expect(fixture.repository.reserveOperation).not.toHaveBeenCalled();
  });

  it('registra recusa como pendente e bloqueia documento recusado, concluído ou cancelado', async () => {
    const fixture = serviceFixture();
    expect(
      await fixture.service.reserve(fixture.actor, {
        ...fixture.input,
        acao: 'recusar',
        campos: [],
        motivo: 'Discordo do conteúdo.',
      }),
    ).toMatchObject({
      acao: 'recusar',
      situacao: 'pendente',
      documentoConcluido: false,
      pdfDisponivel: false,
    });
    fixture.repository.reserveOperation.mockClear();
    for (const status of ['REJECTED', 'COMPLETED', 'DRAFT']) {
      const service = createSemogSigningService({
        ...fixture.dependencies,
        readCurrent: async () => ({
          envelope: { ...fixture.envelope, status },
          pdf: fixture.pdf,
        }),
      });
      await expect(service.reserve(fixture.actor, fixture.input)).rejects.toThrow();
    }
    const service = createSemogSigningService({
      ...fixture.dependencies,
      readCurrent: async () => ({
        envelope: { ...fixture.envelope, deletedAt: new Date() },
        pdf: fixture.pdf,
      }),
    });
    await expect(service.reserve(fixture.actor, fixture.input)).rejects.toThrow();
    expect(fixture.repository.reserveOperation).not.toHaveBeenCalled();
  });
  it('defaults disabled before authentication, current reads or persistence', async () => {
    const fixture = serviceFixture();
    const service = createSemogSigningService({ ...fixture.dependencies, enabled: undefined });
    await expect(service.authenticate('token')).rejects.toMatchObject({ statusCode: 503 });
    await expect(service.enroll(fixture.actor, fixture.enrollment)).rejects.toMatchObject({ statusCode: 503 });
    expect(fixture.authenticate).not.toHaveBeenCalled();
    expect(fixture.readCurrent).not.toHaveBeenCalled();
    expect(fixture.repository.registerSnapshot).not.toHaveBeenCalled();
  });
  it('does not expose private snapshot content at enrollment', async () => {
    const fixture = serviceFixture();
    const result = await fixture.service.enroll(fixture.actor, fixture.enrollment);
    expect(result).toEqual({
      id: expect.any(String),
      envelopeId: 'env',
      recipientId: 10,
      hashDocumento: fixture.snapshot.hashDocumento,
      hashConsentimento: fixture.snapshot.hashConsentimento,
      hashSnapshot: fixture.snapshot.hashSnapshot,
      expiraEm: fixture.enrollment.expiraEm,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|Li e concordo|conteudo|teamId/);
  });
  it('records full evidence and remains pending after valid reservation', async () => {
    const fixture = serviceFixture();
    const result = await fixture.service.reserve(fixture.actor, fixture.input);
    expect(result).toMatchObject({ situacao: 'pendente', documentoConcluido: false, pdfDisponivel: false });
    expect(fixture.repository.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: fixture.snapshot.id,
        teamId: 1,
        pedido: fixture.input,
        evidencias: { ...fixture.input.evidencias, metodoAutenticacao: 'codigo' },
      }),
    );
  });
  it('replays an identical durable operation without reading an expired or revoked snapshot', async () => {
    const fixture = serviceFixture();
    await fixture.service.reserve(fixture.actor, fixture.input);
    const reserved = await fixture.repository.reserveOperation.mock.results[0].value;
    fixture.repository.getOperation.mockResolvedValue(reserved);
    fixture.repository.getSnapshot.mockResolvedValue(null);
    fixture.readCurrent.mockClear();
    const result = await fixture.service.reserve(fixture.actor, fixture.input);
    expect(result.situacao).toBe('pendente');
    expect(fixture.readCurrent).not.toHaveBeenCalled();
    expect(fixture.repository.reserveOperation).toHaveBeenCalledTimes(1);
  });
  it('rejects a conflicting retry and a cross-team record', async () => {
    const fixture = serviceFixture();
    await fixture.service.reserve(fixture.actor, fixture.input);
    const reserved = await fixture.repository.reserveOperation.mock.results[0].value;
    fixture.repository.getOperation.mockResolvedValue(reserved);
    await expect(
      fixture.service.reserve(fixture.actor, { ...fixture.input, acao: 'recusar', campos: [] }),
    ).rejects.toMatchObject({ statusCode: 409 });
    fixture.repository.getOperation.mockResolvedValue({ ...reserved, teamId: 2 });
    await expect(fixture.service.get(fixture.actor, fixture.input.chaveOperacao)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
  it('binds current bytes, geometry and signer state before reserving', async () => {
    for (const mutation of ['bytes', 'geometry', 'signed']) {
      const fixture = serviceFixture();
      if (mutation === 'bytes') {
        fixture.readCurrent.mockResolvedValue({
          envelope: fixture.envelope,
          pdf: new TextEncoder().encode('%PDF-1.7 changed'),
        });
      } else if (mutation === 'geometry') {
        fixture.envelope.fields[0].width += 1;
      } else {
        fixture.envelope.recipients[0].signingStatus = 'SIGNED';
      }
      await expect(fixture.service.reserve(fixture.actor, fixture.input)).rejects.toThrow();
      expect(fixture.repository.reserveOperation).not.toHaveBeenCalled();
    }
  });
  it('rejects foreign fields, missing signature and character-limit overflow', async () => {
    const fixture = serviceFixture();
    for (const campos of [
      [{ fieldId: 999, valor: 'Test' }],
      [],
      [
        { fieldId: 20, valor: 'Test' },
        { fieldId: 21, valor: 'x'.repeat(21) },
      ],
    ]) {
      await expect(fixture.service.reserve(fixture.actor, { ...fixture.input, campos })).rejects.toMatchObject({
        statusCode: 400,
      });
    }
    expect(fixture.repository.reserveOperation).not.toHaveBeenCalled();
  });
  it('canonicalizes ordering without changing text and binds evidence', () => {
    const fixture = serviceFixture();
    const value = {
      ...fixture.input,
      campos: [
        { fieldId: 20, valor: 'Test' },
        { fieldId: 21, valor: 'Parecer\nexato' },
      ],
    };
    expect(hashSemogManifestation(value)).toBe(
      hashSemogManifestation({ ...value, campos: [...value.campos].reverse() }),
    );
    expect(hashSemogManifestation(value)).not.toBe(
      hashSemogManifestation({ ...value, evidencias: { ...value.evidencias, canal: 'whatsapp' } }),
    );
  });
  it('does not accept tenant identity or arbitrary UUID substitutions from the body', async () => {
    const fixture = serviceFixture();
    await expect(fixture.service.reserve(fixture.actor, { ...fixture.input, teamId: 2 })).rejects.toThrow();
    await expect(
      fixture.service.reserve(fixture.actor, { ...fixture.input, chaveOperacao: 'generic-key' }),
    ).rejects.toThrow();
  });
});
