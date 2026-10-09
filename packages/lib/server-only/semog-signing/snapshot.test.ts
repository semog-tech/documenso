import { describe, expect, it } from 'vitest';

import { buildSemogSnapshot, canonicalSemogJson } from './snapshot';

const optionalOrder = (): number | null => null;
const fixture = () => ({
  teamId: 1,
  recipientId: 10,
  pdf: new TextEncoder().encode('%PDF-1.7 fixture'),
  consentimento: 'Li e concordo com este documento.',
  expiraEm: '2099-01-01T00:00:00.000Z',
  envelope: {
    id: 'env',
    teamId: 1,
    title: 'Documento de teste',
    type: 'DOCUMENT',
    internalVersion: 2,
    status: 'PENDING',
    signatureLevel: 'SES',
    useLegacyFieldInsertion: false,
    deletedAt: null,
    authOptions: null,
    envelopeAttachments: [],
    documentMeta: {
      signingOrder: 'PARALLEL',
      allowDictateNextSigner: false,
      typedSignatureEnabled: true,
      uploadSignatureEnabled: true,
      drawSignatureEnabled: true,
      language: 'pt-BR',
      timezone: 'America/Recife',
      dateFormat: null,
      distributionMethod: 'NONE',
    },
    envelopeItems: [
      {
        id: 'item',
        envelopeId: 'env',
        title: 'PDF',
        order: 0,
        documentDataId: 'data',
        documentData: { id: 'data', initialData: 'storage/reference' },
      },
    ],
    recipients: [
      {
        id: 10,
        envelopeId: 'env',
        email: 'teste@example.org',
        name: 'Teste',
        token: 'secret-signing-token',
        role: 'SIGNER',
        signingStatus: 'NOT_SIGNED',
        signingOrder: optionalOrder(),
        signedAt: null,
        expiresAt: null,
        documentDeletedAt: null,
        authOptions: null,
      },
    ],
    fields: [
      {
        id: 20,
        envelopeId: 'env',
        envelopeItemId: 'item',
        recipientId: 10,
        type: 'SIGNATURE',
        page: 1,
        positionX: '10.00',
        positionY: 10,
        width: 20,
        height: 10,
        customText: '',
        inserted: false,
        fieldMeta: { type: 'signature' },
      },
      {
        id: 21,
        envelopeId: 'env',
        envelopeItemId: 'item',
        recipientId: 10,
        type: 'TEXT',
        page: 1,
        positionX: 10,
        positionY: 30,
        width: 20,
        height: 10,
        customText: '',
        inserted: false,
        fieldMeta: { type: 'text', required: false },
      },
    ],
  },
});

const parallelFixture = () => {
  const input = fixture();
  input.envelope.recipients.push({ ...input.envelope.recipients[0], id: 11, token: 'other-token' });
  input.envelope.fields.push({ ...input.envelope.fields[0], id: 30, recipientId: 11 });
  input.envelope.fields.push({ ...input.envelope.fields[1], id: 31, recipientId: 11 });
  return input;
};

describe('buildSemogSnapshot', () => {
  it('preserva inscrição e conteúdo canônico após assinatura paralela alheia', () => {
    const input = parallelFixture();
    const before = buildSemogSnapshot(input);
    const signed = buildSemogSnapshot({
      ...input,
      envelope: {
        ...input.envelope,
        recipients: input.envelope.recipients.map((recipient) =>
          recipient.id === 11
            ? {
                ...recipient,
                signingStatus: 'SIGNED',
                signedAt: '2026-10-06T12:00:00Z',
              }
            : recipient,
        ),
        fields: input.envelope.fields.map((field) =>
          field.recipientId === 11
            ? {
                ...field,
                inserted: true,
                customText: field.type === 'TEXT' ? 'Parecer alheio' : field.customText,
              }
            : field,
        ),
      },
    });
    expect(signed.hashSnapshot).toBe(before.hashSnapshot);
    expect(signed.conteudo).toEqual(before.conteudo);
  });

  it('continua vinculando contatos, tokens, geometria e metadata dos demais signatários', () => {
    const original = buildSemogSnapshot(parallelFixture()).hashSnapshot;
    const inputs = [parallelFixture(), parallelFixture(), parallelFixture(), parallelFixture()];
    inputs[0].envelope.recipients[1].email = 'changed@example.org';
    inputs[1].envelope.recipients[1].token += '-changed';
    inputs[2].envelope.fields[2].width += 1;
    inputs[3].envelope.fields[3].fieldMeta.required = true;
    for (const input of inputs) {
      expect(buildSemogSnapshot(input).hashSnapshot).not.toBe(original);
    }
  });

  it('conserva valores alheios predefinidos e somente leitura', () => {
    const input = parallelFixture();
    for (const fieldMeta of [
      { type: 'text', text: 'Valor predefinido', readOnly: true },
      { type: 'text', readOnly: true },
    ]) {
      const envelope = {
        ...input.envelope,
        fields: input.envelope.fields.map((field) =>
          field.id === 31
            ? {
                ...field,
                fieldMeta,
                customText: 'Valor predefinido',
                inserted: true,
              }
            : field,
        ),
      };
      const before = buildSemogSnapshot({ ...input, envelope });
      const changed = {
        ...envelope,
        fields: envelope.fields.map((field) =>
          field.id === 31
            ? {
                ...field,
                customText: 'Valor alterado',
              }
            : field,
        ),
      };
      if ('text' in fieldMeta) {
        expect(() => buildSemogSnapshot({ ...input, envelope: changed })).toThrow();
      } else {
        expect(buildSemogSnapshot({ ...input, envelope: changed }).hashSnapshot).not.toBe(before.hashSnapshot);
      }
    }
  });

  it('permite substituir default editável mantendo metadata congelada', () => {
    const input = parallelFixture();
    const fields = input.envelope.fields.map((field) =>
      field.id === 31
        ? {
            ...field,
            fieldMeta: { type: 'text', text: 'Sugestão editável', readOnly: false },
            customText: 'Sugestão editável',
            inserted: true,
          }
        : field,
    );
    const before = buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields } });
    const edited = fields.map((field) =>
      field.id === 31 ? { ...field, customText: 'Decisão do outro signatário' } : field,
    );
    expect(buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields: edited } }).conteudo).toEqual(
      before.conteudo,
    );
    const changed = fields.map((field) =>
      field.id === 31
        ? {
            ...field,
            fieldMeta: { type: 'text', text: 'Outro default', readOnly: false },
          }
        : field,
    );
    expect(buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields: changed } }).hashSnapshot).not.toBe(
      before.hashSnapshot,
    );
  });

  it('usa valores de opções readonly RADIO e CHECKBOX como o validador nativo', () => {
    const input = parallelFixture();
    for (const definition of [
      {
        type: 'RADIO',
        fieldMeta: { type: 'radio', readOnly: true, values: [{ id: 1, value: 'Sim', checked: true }] },
        expected: 'Sim',
      },
      {
        type: 'CHECKBOX',
        fieldMeta: {
          type: 'checkbox',
          readOnly: true,
          values: [
            { id: 1, value: 'Sim', checked: true },
            { id: 2, value: 'Outro', checked: true },
          ],
        },
        expected: '["Sim","Outro"]',
      },
    ]) {
      const fields = input.envelope.fields.map((field) =>
        field.id === 31
          ? {
              ...field,
              type: definition.type,
              fieldMeta: definition.fieldMeta,
              customText: '',
              inserted: false,
            }
          : field,
      );
      const before = buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields } });
      const inserted = fields.map((field) =>
        field.id === 31 ? { ...field, customText: definition.expected, inserted: true } : field,
      );
      expect(buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields: inserted } }).conteudo).toEqual(
        before.conteudo,
      );
      const tampered = inserted.map((field) =>
        field.id === 31 ? { ...field, customText: definition.type === 'RADIO' ? '0' : '[0,1]' } : field,
      );
      expect(() => buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields: tampered } })).toThrow();
    }
  });

  it('permite progresso readonly NAME, INITIALS e DATE preservando nome e configuração de formato', () => {
    const input = parallelFixture();
    for (const definition of [
      { type: 'NAME', fieldMeta: { type: 'name', readOnly: true }, value: input.envelope.recipients[1].name },
      { type: 'INITIALS', fieldMeta: { type: 'initials', readOnly: true }, value: 'TE' },
      { type: 'DATE', fieldMeta: { type: 'date', readOnly: true }, value: '06/10/2026' },
    ]) {
      const fields = input.envelope.fields.map((field) =>
        field.id === 31
          ? {
              ...field,
              type: definition.type,
              fieldMeta: definition.fieldMeta,
              customText: '',
              inserted: false,
            }
          : field,
      );
      const before = buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields } });
      const inserted = fields.map((field) =>
        field.id === 31 ? { ...field, customText: definition.value, inserted: true } : field,
      );
      const progressed = { ...input.envelope, fields: inserted };
      expect(buildSemogSnapshot({ ...input, envelope: progressed }).conteudo).toEqual(before.conteudo);
      const contacts = progressed.recipients.map((recipient) =>
        recipient.id === 11 ? { ...recipient, name: 'Outro contato' } : recipient,
      );
      expect(buildSemogSnapshot({ ...input, envelope: { ...progressed, recipients: contacts } }).hashSnapshot).not.toBe(
        before.hashSnapshot,
      );
      expect(
        buildSemogSnapshot({
          ...input,
          envelope: {
            ...progressed,
            documentMeta: {
              ...progressed.documentMeta,
              timezone: 'America/Sao_Paulo',
              dateFormat: 'yyyy-MM-dd',
            },
          },
        }).hashSnapshot,
      ).not.toBe(before.hashSnapshot);
    }
  });

  it('normaliza preenchimento nativo de TEXT predefinido e EMAIL sem perder o vínculo autorizado', () => {
    const input = parallelFixture();
    for (const definition of [
      {
        type: 'TEXT',
        fieldMeta: { type: 'text', readOnly: true, text: 'Valor predefinido' },
        expected: 'Valor predefinido',
      },
      { type: 'EMAIL', fieldMeta: { type: 'email' }, expected: input.envelope.recipients[1].email },
    ]) {
      const fields = input.envelope.fields.map((field) =>
        field.id === 31
          ? {
              ...field,
              type: definition.type,
              fieldMeta: definition.fieldMeta,
              customText: '',
              inserted: false,
            }
          : field,
      );
      const before = buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields } });
      const inserted = fields.map((field) =>
        field.id === 31
          ? {
              ...field,
              customText: definition.expected,
              inserted: true,
            }
          : field,
      );
      const after = buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields: inserted } });
      expect(after.hashSnapshot).toBe(before.hashSnapshot);
      expect(after.conteudo).toEqual(before.conteudo);
      const tampered = inserted.map((field) =>
        field.id === 31 ? { ...field, customText: 'Valor adulterado' } : field,
      );
      expect(() => buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields: tampered } })).toThrow();
      const changedMetadata = fields.map((field) =>
        field.id === 31
          ? {
              ...field,
              type: 'TEXT',
              fieldMeta: { type: 'text', readOnly: true, text: 'Outro default' },
            }
          : field,
      );
      expect(
        buildSemogSnapshot({ ...input, envelope: { ...input.envelope, fields: changedMetadata } }).hashSnapshot,
      ).not.toBe(before.hashSnapshot);
    }
  });

  it('nega recusa alheia enquanto envelope ainda está pendente e assinatura própria', () => {
    const input = parallelFixture();
    expect(() =>
      buildSemogSnapshot({
        ...input,
        envelope: {
          ...input.envelope,
          recipients: input.envelope.recipients.map((recipient) =>
            recipient.id === 11
              ? {
                  ...recipient,
                  signingStatus: 'REJECTED',
                  signedAt: '2026-10-06T12:00:00Z',
                }
              : recipient,
          ),
        },
      }),
    ).toThrow();
    expect(() =>
      buildSemogSnapshot({
        ...input,
        envelope: {
          ...input.envelope,
          fields: input.envelope.fields.map((field) =>
            field.recipientId === 10 ? { ...field, inserted: true } : field,
          ),
        },
      }),
    ).toThrow();
    expect(() => buildSemogSnapshot({ ...input, envelope: { ...input.envelope, status: 'REJECTED' } })).toThrow();
    expect(() => buildSemogSnapshot({ ...input, envelope: { ...input.envelope, deletedAt: new Date() } })).toThrow();
  });
  it('vincula os bytes e consentimento e remove tokens', () => {
    const snapshot = buildSemogSnapshot(fixture());
    expect(snapshot.hashDocumento).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.hashSnapshot).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(snapshot)).not.toContain('secret-signing-token');
    expect(JSON.stringify(snapshot)).not.toContain('storage/reference');
    expect(JSON.stringify(snapshot)).toContain('hashInitialData');
    expect(snapshot.conteudo.consentimento).toBe(fixture().consentimento);
  });

  it('nega data impossível, consentimento excessivo e valores não JSON', () => {
    expect(() => buildSemogSnapshot({ ...fixture(), expiraEm: '2099-02-30T00:00:00Z' })).toThrow();
    expect(() => buildSemogSnapshot({ ...fixture(), consentimento: 'x'.repeat(20_001) })).toThrow();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalSemogJson(cyclic)).toThrow();
    expect(() => canonicalSemogJson({ infinite: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalSemogJson({ missing: undefined })).toThrow();
  });

  it('permite assinatura sem metadata e bloqueia TEXT sem metadata e inserção legacy', () => {
    const input = fixture();
    expect(() =>
      buildSemogSnapshot({
        ...input,
        envelope: { ...input.envelope, fields: [{ ...input.envelope.fields[0], fieldMeta: null }] },
      }),
    ).not.toThrow();
    expect(() =>
      buildSemogSnapshot({ ...input, envelope: { ...input.envelope, useLegacyFieldInsertion: true } }),
    ).toThrow();
    expect(() =>
      buildSemogSnapshot({
        ...input,
        envelope: {
          ...input.envelope,
          fields: [{ ...input.envelope.fields[1], fieldMeta: null }, input.envelope.fields[0]],
        },
      }),
    ).toThrow();
  });

  it('preserva exatamente o consentimento e vincula configuração de expiração e referência inicial', () => {
    const input = fixture();
    input.consentimento = '  Concordo.\n';
    const original = buildSemogSnapshot(input);
    expect(original.conteudo.consentimento).toBe('  Concordo.\n');
    input.envelope.envelopeItems[0].documentData.initialData += '-changed';
    expect(buildSemogSnapshot(input).hashSnapshot).not.toBe(original.hashSnapshot);
    expect(
      buildSemogSnapshot({
        ...fixture(),
        envelope: {
          ...fixture().envelope,
          documentMeta: {
            ...fixture().envelope.documentMeta,
            envelopeExpirationPeriod: { type: 'FIXED', date: '2099-01-01' },
          },
        },
      }).hashSnapshot,
    ).not.toBe(buildSemogSnapshot(fixture()).hashSnapshot);
  });

  it('contato e estado de outro destinatário vinculam a inscrição', () => {
    const input = fixture();
    const other = { ...input.envelope.recipients[0], id: 11, role: 'CC' };
    input.envelope.recipients.push(other);
    const original = buildSemogSnapshot(input).hashSnapshot;
    input.envelope.recipients.reverse();
    expect(buildSemogSnapshot(input).hashSnapshot).toBe(original);
    input.envelope.recipients[0].name = 'Outro contato';
    expect(buildSemogSnapshot(input).hashSnapshot).not.toBe(original);
  });

  it('ordena arrays sem mudar o hash e ignora updatedAt', () => {
    const input = fixture();
    const original = buildSemogSnapshot(input);
    input.envelope.fields.reverse();
    expect(buildSemogSnapshot({ ...input, envelope: { ...input.envelope, updatedAt: new Date() } }).hashSnapshot).toBe(
      original.hashSnapshot,
    );
  });

  it('mudanças nos bytes, consentimento, contato, token, geometria e metadata mudam o hash', () => {
    const original = buildSemogSnapshot(fixture()).hashSnapshot;
    const inputs = [fixture(), fixture(), fixture(), fixture(), fixture(), fixture()];
    inputs[0].pdf = new TextEncoder().encode('%PDF-1.7 changed');
    inputs[1].consentimento += ' Extra';
    inputs[2].envelope.recipients[0].email = 'outro@example.org';
    inputs[3].envelope.recipients[0].token += '-changed';
    inputs[4].envelope.fields[0].width = 21;
    inputs[5].envelope.fields[1].fieldMeta.required = true;
    for (const input of inputs) {
      expect(buildSemogSnapshot(input).hashSnapshot).not.toBe(original);
    }
  });

  it('nega equipe divergente, expirado, CPF/campo incompatível e vínculos órfãos', () => {
    expect(() => buildSemogSnapshot({ ...fixture(), teamId: 2 })).toThrow();
    expect(() => buildSemogSnapshot({ ...fixture(), expiraEm: '2000-01-01T00:00:00Z' })).toThrow();
    const input = fixture();
    input.envelope.fields[0].recipientId = 99;
    expect(() => buildSemogSnapshot(input)).toThrow();
    expect(() =>
      buildSemogSnapshot({
        ...fixture(),
        envelope: { ...fixture().envelope, fields: [{ ...fixture().envelope.fields[1], fieldMeta: null }] },
      }),
    ).toThrow();
  });

  it.each(['TSP', 'AES', 'QES'])('nega nível avançado %s', (signatureLevel) => {
    expect(() => buildSemogSnapshot({ ...fixture(), envelope: { ...fixture().envelope, signatureLevel } })).toThrow();
  });

  it('nega duplicação, autenticação e campo inserido ou somente leitura', () => {
    const source = fixture().envelope;
    for (const envelope of [
      { ...source, fields: [...source.fields, source.fields[0]] },
      { ...source, authOptions: { globalAccessAuth: ['ACCOUNT'], globalActionAuth: [] } },
      { ...source, fields: [{ ...source.fields[0], inserted: true }] },
      { ...source, fields: [{ ...source.fields[0], fieldMeta: { type: 'signature', readOnly: true } }] },
    ]) {
      expect(() => buildSemogSnapshot({ ...fixture(), envelope })).toThrow();
    }
  });

  it('nega ordem sequencial indefinida e predecessores pendentes', () => {
    const input = fixture();
    input.envelope.documentMeta.signingOrder = 'SEQUENTIAL';
    expect(() => buildSemogSnapshot(input)).toThrow();
    const recipient = { ...input.envelope.recipients[0], id: 11, signingOrder: 1 };
    const own = { ...input.envelope.recipients[0], signingOrder: 2 };
    input.envelope.recipients = [own, recipient];
    expect(() => buildSemogSnapshot(input)).toThrow();
    input.envelope.recipients[1].signingStatus = 'SIGNED';
    expect(() => buildSemogSnapshot(input)).not.toThrow();
  });
});
