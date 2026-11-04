import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { afterEach, expect, it, vi } from 'vitest';
import { semogPdfKeyFor } from './pdf-store';
import { putSemogMultipartPdf } from './pdf-store-multipart-candidate';

afterEach(() => vi.restoreAllMocks());
const bytes = Buffer.alloc(21 * 1024 * 1024, 7);
const key = semogPdfKeyFor(createHash('sha256').update(bytes).digest('hex'));
const run = () =>
  putSemogMultipartPdf(new S3Client({ region: 'auto' }), {
    bucket: 'fixture',
    key,
    bytes,
    abortSignal: AbortSignal.timeout(5000),
  });
it('envia quatro partes simultâneas, checksum por parte e composite do objeto', async () => {
  let active = 0;
  let maximum = 0;
  const parts: number[] = [];
  const checksums = new Map<number, Buffer>();
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand) {
      expect(command.input.ChecksumAlgorithm).toBe('SHA256');
      return { UploadId: 'fixture' };
    }
    if (command instanceof UploadPartCommand) {
      const body = command.input.Body;
      if (!(body instanceof Uint8Array)) {
        throw new Error('Expected buffered part');
      }
      const digest = createHash('sha256').update(body).digest();
      expect(command.input.ChecksumSHA256).toBe(digest.toString('base64'));
      checksums.set(command.input.PartNumber ?? 0, digest);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((done) => setTimeout(done, 5));
      active--;
      parts.push(command.input.PartNumber ?? 0);
      return { ETag: 'fixture', ChecksumSHA256: command.input.ChecksumSHA256 };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      expect(command.input.MultipartUpload?.Parts).toHaveLength(4);
      const digests = [...checksums.entries()].sort(([a], [b]) => a - b).map(([, digest]) => digest);
      expect(command.input.ChecksumSHA256).toBe(
        `${createHash('sha256').update(Buffer.concat(digests)).digest('base64')}-4`,
      );
      return { ChecksumSHA256: command.input.ChecksumSHA256 };
    }
    throw new Error('unexpected command');
  });
  await run();
  expect(maximum).toBe(4);
  expect(parts).toHaveLength(4);
  expect(send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(false);
});
it('falha numa parte espera as demais e aborta sem concluir', async () => {
  let pending = 0;
  let aborted = false;
  let completed = false;
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand) {
      return { UploadId: 'fixture' };
    }
    if (command instanceof UploadPartCommand) {
      pending++;
      await new Promise((done) => setTimeout(done, 5));
      pending--;
      if (command.input.PartNumber === 2) {
        throw new Error('part failure');
      }
      return { ETag: 'fixture', ChecksumSHA256: command.input.ChecksumSHA256 };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      expect(pending).toBe(0);
      aborted = true;
      return {};
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      completed = true;
    }
    throw new Error('unexpected command');
  });
  await expect(run()).rejects.toThrow('part failure');
  expect(aborted).toBe(true);
  expect(completed).toBe(false);
});
