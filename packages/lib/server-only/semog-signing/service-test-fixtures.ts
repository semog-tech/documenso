import { vi } from 'vitest';
import type { SemogSigningRepositoryPort } from './service';
import { createSemogSigningService } from './service';
import { ZSemogManifestation } from './service-validation';
import { buildSemogSnapshot } from './snapshot';

export const serviceFixture = () => {
  const envelope = {
    id: 'env',
    teamId: 1,
    title: 'Test document',
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
      uploadSignatureEnabled: false,
      drawSignatureEnabled: false,
      language: 'pt-BR',
      timezone: null,
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
        documentData: { id: 'data', initialData: 'private-reference' },
      },
    ],
    recipients: [
      {
        id: 10,
        envelopeId: 'env',
        email: 'test@example.org',
        name: 'Test',
        token: 'private-token',
        role: 'SIGNER',
        signingStatus: 'NOT_SIGNED',
        signingOrder: null,
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
        positionX: 10,
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
        fieldMeta: { type: 'text', required: false, characterLimit: 20 },
      },
    ],
  };
  const pdf = new TextEncoder().encode('%PDF-1.7 test');
  const enrollment = {
    envelopeId: 'env',
    recipientId: 10,
    consentimento: 'Li e concordo.',
    expiraEm: '2099-01-01T00:00:00.000Z',
  };
  const snapshot = buildSemogSnapshot({ envelope, pdf, teamId: 1, ...enrollment });
  const input = ZSemogManifestation.parse({
    chaveOperacao: 'd8f84dc6-519a-4938-b7b4-536bbfcd4b16',
    envelopeId: 'env',
    recipientId: 10,
    hashDocumento: snapshot.hashDocumento,
    hashConsentimento: snapshot.hashConsentimento,
    acao: 'assinar',
    motivo: null,
    campos: [{ fieldId: 20, valor: 'Test' }],
    evidencias: {
      canal: 'email',
      identificacaoId: 'contact',
      confirmadoEm: '2026-10-06T00:00:00Z',
      ip: null,
      userAgent: null,
    },
  });
  const repository = {
    registerSnapshot: vi.fn<SemogSigningRepositoryPort['registerSnapshot']>(async (value) => value),
    getSnapshot: vi.fn<SemogSigningRepositoryPort['getSnapshot']>(async () => snapshot),
    getOperation: vi.fn<SemogSigningRepositoryPort['getOperation']>(async () => null),
    reserveOperation: vi.fn<SemogSigningRepositoryPort['reserveOperation']>(async (value) => ({
      ...value,
      criadaEm: '2026-10-06T00:00:00Z',
      estado: 'pendente',
    })),
  };
  const readCurrent = vi.fn(async () => ({ envelope, pdf }));
  const authenticate = vi.fn(async () => ({ teamId: 1, userId: 2 }));
  const dependencies = { enabled: true, repository, readCurrent, authenticate };
  return {
    envelope,
    pdf,
    enrollment,
    snapshot,
    input,
    repository,
    readCurrent,
    authenticate,
    dependencies,
    actor: { teamId: 1, userId: 2 },
    service: createSemogSigningService(dependencies),
  };
};
