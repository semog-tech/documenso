/** Extract the immutable production transport and run both versions on disposable PostgreSQL/HTTP S3. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseline = '4d3fc306';
const directory = 'packages/lib/server-only/semog-signing';
const suffix = randomUUID();
const transportName = `.semog-pdf-baseline-${suffix}`;
const transport = resolve(directory, `${transportName}.ts`);
const generated = resolve('scripts', `.semog-storage-rehearsal-${suffix}.ts`);
const run = (program: string, args: string[], inherit = false) =>
  new Promise<string>((done, reject) => {
    const child = spawn(program, args, { stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? done(output) : reject(new Error(`Rehearsal exited ${code}: ${output}`))));
  });
const replace = (source: string, marker: string, replacement: string) => {
  if (!source.includes(marker) || source.indexOf(marker) !== source.lastIndexOf(marker)) {
    throw new Error(`Missing/ambiguous rehearsal marker: ${marker}`);
  }
  return source.replace(marker, replacement);
};
try {
  const source = await run('git', ['show', `${baseline}:${directory}/pdf-store-s3.ts`]);
  let rounds = await readFile('scripts/semog-signing-rounds-local.ts', 'utf8');
  rounds = `import { createSemogS3PdfStore as baselineStore } from '../${directory}/${transportName}';
import { runPdfStorageScenario } from './semog-signing-pdf-storage-scenario';\n${rounds}`;
  rounds = replace(
    rounds,
    "if (process.env.SEMOG_LARGE_PDF_ONLY === 'true') {\n    await largePdfScenario(client, owner, services);",
    "if (process.env.SEMOG_LARGE_PDF_ONLY === 'true') {\n    await runPdfStorageScenario({ database: client, actor: owner.actor, services, workspace, root, baselineStore });",
  );
  await writeFile(transport, source);
  await writeFile(generated, rounds);
  if (process.argv.includes('--prepare-only')) {
    console.log('ok - immutable baseline extracted and runner instrumentation validated');
  } else {
    process.env.SEMOG_LARGE_PDF_ONLY = 'true';
    await run(
      process.execPath,
      [
        '--max-old-space-size=8192',
        'node_modules/vite-node/vite-node.mjs',
        '--config',
        'packages/lib/vitest.config.ts',
        generated,
      ],
      true,
    );
  }
} finally {
  for (const path of [generated, transport]) {
    await unlink(path).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    });
  }
}
