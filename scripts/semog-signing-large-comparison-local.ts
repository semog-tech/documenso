/** Reproducible baseline/current comparison on one disposable PostgreSQL and one exact sealed PDF. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseline = '0b87ef3e72a6fd2e272f3cb1116a951dcee30752';
const run = (program: string, args: string[], inherit = false) =>
  new Promise<string>((done, reject) => {
    const child = spawn(program, args, {
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SEMOG_LARGE_PDF_ONLY: 'true' },
    });
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
const replace = (source: string, needle: string, replacement: string) => {
  if (!source.includes(needle) || source.indexOf(needle) !== source.lastIndexOf(needle)) {
    throw new Error(`Baseline instrumentation marker missing or ambiguous: ${needle}`);
  }
  return source.replace(needle, replacement);
};
const directory = 'packages/lib/server-only/semog-signing';
const suffix = randomUUID();
const executionName = `.semog-baseline-execution-${suffix}`;
const observedName = `.semog-baseline-observed-${suffix}`;
const generated = resolve('scripts', `.semog-large-comparison-${suffix}.ts`);
const executionPath = resolve(directory, `${executionName}.ts`);
const observedPath = resolve(directory, `${observedName}.ts`);
try {
  let observed = await run('git', ['show', `${baseline}:${directory}/execution-observed.ts`]);
  observed = replace(
    observed,
    "const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');",
    `export const baselineTimings: {stage: string; ms: number}[] = [];
const sha256 = (value: string | Uint8Array) => { const start = performance.now();
const hash = createHash('sha256').update(value).digest('hex');
baselineTimings.push({stage:'hash',ms:performance.now()-start}); return hash; };`,
  );
  observed = replace(
    observed,
    'const inspectSealed = async (pdf: Uint8Array) => {',
    'const inspectSealed = async (pdf: Uint8Array) => {\n  const started = performance.now();',
  );
  observed = replace(
    observed,
    'await validateSemogPdf(pdf, [], SEMOG_MAX_SEALED_PDF_BYTES);',
    "await validateSemogPdf(pdf, [], SEMOG_MAX_SEALED_PDF_BYTES);\n    baselineTimings.push({stage:'parse',ms:performance.now()-started});",
  );
  observed = replace(
    observed,
    '    const data = await readSealedSource(client, actor, key);',
    "    const started = performance.now();\n    const data = await readSealedSource(client, actor, key);\n    baselineTimings.push({stage:'source.transaction',ms:performance.now()-started});",
  );
  let execution = await run('git', ['show', `${baseline}:${directory}/execution.ts`]);
  if (execution.split("'./execution-observed'").length !== 3) {
    throw new Error('Expected the baseline type and value imports of execution-observed');
  }
  execution = execution.replaceAll("'./execution-observed'", `'./${observedName}'`);
  execution = replace(execution, '  prepareSemogObserved,', '  prepareSemogObserved,\n  baselineTimings,');
  execution = replace(
    execution,
    '  const readLocked = (actor: SemogActor, key: string, prepared: SemogPreparedObserved) =>\n    dependencies.client.$transaction(',
    '  const readLocked = (actor: SemogActor, key: string, prepared: SemogPreparedObserved) => {\n    const started = performance.now();\n    return dependencies.client.$transaction(',
  );
  execution = replace(
    execution,
    "{ isolationLevel: 'Serializable', timeout: 10000, maxWait: 10000 },\n    );\n  return {",
    "{ isolationLevel: 'Serializable', timeout: 10000, maxWait: 10000 },\n    ).finally(() => baselineTimings.push({stage:'locked.transaction',ms:performance.now()-started}));\n  };\n  return {",
  );
  let rounds = await readFile(resolve('scripts/semog-signing-rounds-local.ts'), 'utf8');
  rounds = `import { createSemogPrismaExecutor as createBaselineExecutor } from '../${directory}/${executionName}';
import { baselineTimings } from '../${directory}/${observedName}';\n${rounds}`;
  rounds = replace(
    rounds,
    '  const downloaded = await measureSealedExecutor(database, owner.actor, key);',
    `  await measureSealedExecutor(database, owner.actor, key, { createExecutor: createBaselineExecutor,
    label: 'baseline-${baseline.slice(0, 7)}', extraTimings: baselineTimings });
  const downloaded = await measureSealedExecutor(database, owner.actor, key);`,
  );
  await writeFile(observedPath, observed);
  await writeFile(executionPath, execution);
  await writeFile(generated, rounds);
  if (process.argv.includes('--prepare-only')) {
    console.log('ok - baseline sources extracted and instrumentation markers validated');
  } else {
    await run(
      process.execPath,
      [
        '--max-old-space-size=8192',
        resolve('node_modules/vite-node/vite-node.mjs'),
        '--config',
        'packages/lib/vitest.config.ts',
        generated,
      ],
      true,
    );
  }
} finally {
  for (const path of [generated, executionPath, observedPath]) {
    await unlink(path).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    });
  }
}
