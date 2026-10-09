import { createHash } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { AppErrorCode } from '../../errors/app-error';
import { SEMOG_DRAFT_MAX_PDF_BYTES, type SemogDraftRequest, ZSemogDraftRequest } from './draft-contract';
import { semogError } from './service-validation';
import { canonicalSemogJson } from './snapshot';

export const semogDraftMaximum = (maximum = SEMOG_DRAFT_MAX_PDF_BYTES) => {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > SEMOG_DRAFT_MAX_PDF_BYTES) {
    throw semogError(AppErrorCode.INVALID_REQUEST, 400);
  }
  return maximum;
};
const decodePdf = (input: SemogDraftRequest, maximum: number) => {
  const encoded = input.arquivo.pdfBase64;
  if (encoded.length > 4 * Math.ceil(maximum / 3)) {
    throw semogError(AppErrorCode.LIMIT_EXCEEDED, 413);
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length > maximum ||
    bytes.toString('base64') !== encoded ||
    createHash('sha256').update(bytes).digest('hex') !== input.arquivo.sha256
  ) {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
  return bytes;
};
export const validateSemogDraft = async (body: unknown, maximum: number) => {
  const input = ZSemogDraftRequest.parse(body);
  const bytes = decodePdf(input, semogDraftMaximum(maximum));
  try {
    const pdf = await PDFDocument.load(bytes);
    const count = pdf.getPageCount();
    if (count === 0 || input.signatarios.some((recipient) => recipient.campos.some((field) => field.pagina > count))) {
      throw semogError(AppErrorCode.INVALID_BODY, 400);
    }
  } catch {
    throw semogError(AppErrorCode.INVALID_BODY, 400);
  }
  // Canonical Base64 was verified above: hash + byte length bind the exact bytes without another 138 MiB JSON copy.
  const request = {
    ...input,
    arquivo: { nome: input.arquivo.nome, sha256: input.arquivo.sha256, tamanho: bytes.length },
  };
  const hash = createHash('sha256')
    .update(JSON.stringify(canonicalSemogJson(request)))
    .digest('hex');
  return { input, hash };
};
