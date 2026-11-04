/** Synthetic, disposable large-PDF rehearsal helpers. No production access or personal content. */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { PrismaClient } from '@prisma/client';
import { createSemogPrismaExecutor } from '../packages/lib/server-only/semog-signing/execution';
import { createSemogPdfReader } from '../packages/lib/server-only/semog-signing/initial-pdf';
import type { SemogActor } from '../packages/lib/server-only/semog-signing/service';
import type { SemogStageTiming } from '../packages/lib/server-only/semog-signing/timing';

type Measurement = { stage: string; ms: number; bytes?: number };
type ExecutorFactory = typeof createSemogPrismaExecutor;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Random attachment remains approximately 55 MiB after compression and native sealing. */
export const buildLargeRehearsalPdf = async (examplePath: string) => {
  const pdf = await PDFDocument.load(await readFile(examplePath));
  await pdf.attach(randomBytes(55 * 1024 * 1024), 'synthetic-fixture.bin', {
    mimeType: 'application/octet-stream',
    description: 'Synthetic random bytes; no personal or production document data.',
  });
  return Buffer.from(await pdf.save()).toString('base64');
};

export const measureSealedExecutor = async (
  client: PrismaClient,
  actor: SemogActor,
  key: string,
  options: { createExecutor?: ExecutorFactory; label?: string; extraTimings?: Measurement[] } = {},
) => {
  let measurements: Measurement[] = [];
  const readPdf = createSemogPdfReader();
  const executor = (options.createExecutor ?? createSemogPrismaExecutor)({
    enabled: true,
    client,
    observe: (timing: SemogStageTiming) => measurements.push(timing),
    readPdf: async (source) => {
      const started = performance.now();
      const bytes = await readPdf(source);
      measurements.push({ stage: 'reader.decode', ms: performance.now() - started, bytes: bytes.byteLength });
      return bytes;
    },
  });
  let expectedHash: string | undefined;
  for (const method of ['get', 'pdf'] as const) {
    // Three consecutive measured calls reveal warm-run variation without a different fixture.
    for (let iteration = 1; iteration <= 3; iteration++) {
      measurements = [];
      if (options.extraTimings) {
        options.extraTimings.length = 0;
      }
      const started = performance.now();
      const result = await executor[method](actor, key);
      const totalMs = performance.now() - started;
      const extras = [...(options.extraTimings ?? [])];
      if (method === 'get') {
        if (result instanceof Uint8Array || !result.documentoConcluido || !result.pdfDisponivel) {
          throw new Error('Large-PDF state failed to confirm the sealed document');
        }
      } else {
        if (!(result instanceof Uint8Array)) {
          throw new Error('Large-PDF download returned no bytes');
        }
        const currentHash = hash(result);
        if (expectedHash && currentHash !== expectedHash) {
          throw new Error('Large-PDF bytes changed between downloads');
        }
        expectedHash = currentHash;
      }
      console.log(
        JSON.stringify({
          rehearsal: 'large-pdf',
          label: options.label ?? 'current',
          method,
          iteration,
          totalMs: Math.round(totalMs * 100) / 100,
          measurements: [...measurements, ...extras],
        }),
      );
    }
  }
  return await executor.pdf(actor, key);
};

/** Verifies the exact downloaded bytes with OpenSSL; -noverify skips trust-chain policy, not CMS integrity. */
export const verifyLargePdfCms = async (bytes: Uint8Array, directory: string) => {
  const raw = Buffer.from(bytes);
  const text = raw.toString('latin1');
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  const contents = /\/Contents\s*<([a-fA-F0-9]+)>/.exec(text);
  if (!range || !contents) {
    throw new Error('Large PDF has no detached CMS');
  }
  const [start, length, second, end] = range.slice(1).map(Number);
  const contentsStart = text.indexOf('<', contents.index);
  const contentsEnd = contentsStart + contents[1].length + 2;
  if (start !== 0 || second + end !== raw.length || length !== contentsStart || second !== contentsEnd) {
    throw new Error('CMS ByteRange must cover the entire PDF except its Contents token');
  }
  const contentPath = join(directory, 'large-content.bin');
  const signaturePath = join(directory, 'large-signature.der');
  await writeFile(
    contentPath,
    Buffer.concat([raw.subarray(start, start + length), raw.subarray(second, second + end)]),
  );
  await writeFile(signaturePath, Buffer.from(contents[1], 'hex'));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.SEMOG_OPENSSL_BIN ?? '/opt/homebrew/bin/openssl', [
      'cms',
      '-verify',
      '-binary',
      '-inform',
      'DER',
      '-in',
      signaturePath,
      '-content',
      contentPath,
      '-noverify',
      '-out',
      join(directory, 'large-verified.bin'),
    ]);
    let diagnostic = '';
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostic += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(diagnostic))));
  });
  console.log(`ok - large PDF CMS verified by OpenSSL (${bytes.byteLength} bytes; SHA-256 ${hash(bytes)})`);
};
