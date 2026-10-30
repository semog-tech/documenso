import { AppErrorCode } from '../../errors/app-error';
import { semogError } from './service-validation';

/** Room for `metadados` (up to 100 signers x 200 fields) plus the multipart framing, on top of the PDF limit. */
export const SEMOG_DRAFT_METADATA_MAX_BYTES = 1024 * 1024;
export const semogDraftBinaryBodyLimit = (maximum: number) => maximum + SEMOG_DRAFT_METADATA_MAX_BYTES + 64 * 1024;

const invalid = () => semogError(AppErrorCode.INVALID_BODY, 400);
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
// RFC 2046 boundary alphabet; a trailing space is not allowed.
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;

export const semogMultipartBoundary = (contentType: string | null) => {
  const match = /^\s*multipart\/form-data\s*;(.*)$/i.exec(contentType ?? '');
  const parameter = match ? /(?:^|;)\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(match[1]) : null;
  const boundary = parameter?.[1] ?? parameter?.[2];
  return boundary !== undefined && BOUNDARY.test(boundary) ? boundary : null;
};

type Part = { name: string; type: string; content: Buffer };
const parseHeaders = (text: string) => {
  const headers = new Map<string, string>();
  for (const line of text.split('\r\n')) {
    const separator = line.indexOf(':');
    const name = line.slice(0, separator).trim().toLowerCase();
    if (separator <= 0 || headers.has(name)) {
      throw invalid();
    }
    headers.set(name, line.slice(separator + 1).trim());
  }
  const disposition = /^form-data\s*;(.*)$/i.exec(headers.get('content-disposition') ?? '');
  const name = disposition ? /(?:^|;)\s*name="([^"]+)"/.exec(disposition[1])?.[1] : undefined;
  const type = headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!name || !type) {
    throw invalid();
  }
  return { name, type };
};
const readParts = (body: Buffer, boundary: string) => {
  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.concat([CRLF, delimiter]);
  if (!body.subarray(0, delimiter.length).equals(delimiter)) {
    throw invalid();
  }
  const parts: Part[] = [];
  let cursor = delimiter.length;
  while (body.subarray(cursor, cursor + 2).toString('latin1') !== '--') {
    if (!body.subarray(cursor, cursor + 2).equals(CRLF) || parts.length === 2) {
      throw invalid();
    }
    const headerEnd = body.indexOf(HEADER_END, cursor + 2);
    if (headerEnd < 0 || headerEnd - cursor > 8192) {
      throw invalid();
    }
    const headers = parseHeaders(body.subarray(cursor + 2, headerEnd).toString('latin1'));
    const next = body.indexOf(separator, headerEnd + HEADER_END.length);
    if (next < 0) {
      throw invalid();
    }
    // subarray, not a copy: the PDF part stays a view over the received bytes.
    parts.push({ ...headers, content: body.subarray(headerEnd + HEADER_END.length, next) });
    cursor = next + separator.length;
  }
  return parts;
};

/**
 * Exactly two parts, in this order: `metadados` (application/json) and `arquivo` (application/pdf, raw bytes).
 * Anything else — extra, missing or reordered parts, other types — is a malformed request.
 */
export const parseSemogDraftMultipart = (body: Buffer, boundary: string) => {
  const parts = readParts(body, boundary);
  if (parts.length !== 2) {
    throw invalid();
  }
  const [metadata, file] = parts;
  if (
    metadata.name !== 'metadados' ||
    metadata.type !== 'application/json' ||
    metadata.content.byteLength > SEMOG_DRAFT_METADATA_MAX_BYTES ||
    file.name !== 'arquivo' ||
    file.type !== 'application/pdf'
  ) {
    throw invalid();
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata.content));
    return { metadata: parsed, pdf: new Uint8Array(file.content.buffer, file.content.byteOffset, file.content.length) };
  } catch {
    throw invalid();
  }
};
