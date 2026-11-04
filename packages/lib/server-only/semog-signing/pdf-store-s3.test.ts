import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSemogPdfDiskCache } from './pdf-disk-cache';
import { semogPdfKeyFor } from './pdf-store';
import { createSemogS3PdfStore, createSemogS3PurgeObjects, semogS3SettingsFromEnv } from './pdf-store-s3';
import type { SemogStageObserver, SemogStageTiming } from './timing';

type Behaviour = (request: IncomingMessage, response: ServerResponse) => void;
const servers: Server[] = [];
const fakeS3 = async (behaviour: Behaviour) => {
  const server = createServer(behaviour);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // listen(0) on TCP always yields AddressInfo
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
const bytes = new TextEncoder().encode('%PDF-1.7 prazo');
const key = semogPdfKeyFor(createHash('sha256').update(bytes).digest('hex'));
/** Production connect/headers values; only the shared operation deadline is shortened (6 s) to keep tests fast. */
const store = async (behaviour: Behaviour, observe?: SemogStageObserver) =>
  createSemogS3PdfStore(
    {
      bucket: 'local',
      endpoint: await fakeS3(behaviour),
      forcePathStyle: true,
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
      timeouts: { connectMs: 5000, headersMs: 20000, operationMs: 6000 },
    },
    observe,
  );
const elapsed = async (operation: () => Promise<unknown>) => {
  const started = Date.now();
  await expect(operation()).rejects.toBeDefined();
  return Date.now() - started;
};

describe('Cliente S3 da ponte: um prazo único por operação', () => {
  it('HEAD lento (404 depois de 4 s) seguido de PUT mudo: a gravação inteira cai no prazo único, não 4 s + 6 s', async () => {
    const s3 = await store((request, response) => {
      if (request.method === 'HEAD') {
        setTimeout(() => response.writeHead(404).end(), 4000);
      }
      // PUT: reads the upload and never answers.
      request.resume();
    });
    const spent = await elapsed(() => s3.write(key, bytes));
    expect(spent).toBeGreaterThan(5500);
    expect(spent).toBeLessThan(9000);
  }, 30000);
  it('corpo que trava depois dos cabeçalhos: a leitura cai no prazo único (o de cabeçalhos já foi limpo)', async () => {
    const s3 = await store((_request, response) => {
      response.writeHead(200, { 'Content-Length': '100000', 'Content-Type': 'application/pdf' });
      response.write('%PDF-1.7 parcial');
    });
    const spent = await elapsed(() => s3.read(key));
    expect(spent).toBeGreaterThan(5500);
    expect(spent).toBeLessThan(9000);
  }, 30000);
  it('servidor que aceita a conexão e nunca responde: leitura e gravação caem no prazo', async () => {
    const s3 = await store((request) => request.resume());
    expect(await elapsed(() => s3.read(key))).toBeLessThan(9000);
    expect(await elapsed(() => s3.write(key, bytes))).toBeLessThan(9000);
  }, 30000);
  it('recusa gravar bytes sob uma chave que não é o hash deles, sem tocar a rede', async () => {
    const s3 = createSemogS3PdfStore({ bucket: 'local', endpoint: 'http://127.0.0.1:9', forcePathStyle: true });
    await expect(s3.write(key, new TextEncoder().encode('%PDF-1.7 outro'))).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('Cliente S3 da purga', () => {
  const purge = async (behaviour: Behaviour) =>
    createSemogS3PurgeObjects({
      bucket: 'local',
      endpoint: await fakeS3(behaviour),
      forcePathStyle: true,
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
      timeouts: { connectMs: 5000, headersMs: 20000, operationMs: 6000 },
    });
  it('data de gravação vem do HEAD; objeto ausente é null, não erro', async () => {
    const seen: string[] = [];
    const s3 = await purge((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      if (request.url?.includes(key)) {
        response.writeHead(200, { 'Last-Modified': 'Wed, 01 Jul 2026 00:00:00 GMT', 'Content-Length': '0' }).end();
        return;
      }
      response.writeHead(404).end();
    });
    expect((await s3.lastModified(key))?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(await s3.lastModified(semogPdfKeyFor('0'.repeat(64)))).toBeNull();
    expect(seen.every((line) => line.startsWith('HEAD /local/semog/pdf/'))).toBe(true);
  });
  it('apaga só chave da ponte: outra chave é recusada sem tocar a rede', async () => {
    const seen: string[] = [];
    const s3 = await purge((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.writeHead(204).end();
    });
    await s3.remove(key);
    expect(seen).toEqual([`DELETE /local/${key}?x-id=DeleteObject`]);
    await expect(s3.remove('abc123/nativo.pdf')).rejects.toMatchObject({ statusCode: 409 });
    expect(seen).toHaveLength(1);
  });
  it('variáveis do transporte nativo viram a configuração; sem s3 não há armazenamento', () => {
    const env: Record<string, string> = {
      NEXT_PUBLIC_UPLOAD_TRANSPORT: 's3',
      NEXT_PRIVATE_UPLOAD_BUCKET: 'documenso',
      NEXT_PRIVATE_UPLOAD_ENDPOINT: 'https://r2.example.invalid',
      NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE: 'true',
      NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID: 'id',
      NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY: 'segredo',
    };
    expect(semogS3SettingsFromEnv((name) => env[name])).toEqual({
      bucket: 'documenso',
      endpoint: 'https://r2.example.invalid',
      region: undefined,
      forcePathStyle: true,
      credentials: { accessKeyId: 'id', secretAccessKey: 'segredo' },
    });
    expect(semogS3SettingsFromEnv((name) => ({ ...env, NEXT_PUBLIC_UPLOAD_TRANSPORT: 'database' })[name])).toBe(
      undefined,
    );
    expect(() => semogS3SettingsFromEnv((name) => ({ ...env, NEXT_PRIVATE_UPLOAD_BUCKET: '' })[name])).toThrow();
  });
});

describe('Medição do transporte S3 sem dados do objeto', () => {
  it('separa checksum do PUT real e informa bytes sem chave, bucket ou conteúdo', async () => {
    const timings: SemogStageTiming[] = [];
    const received: string[] = [];
    const s3 = await store(
      (request, response) => {
        received.push(request.method ?? '');
        request.resume();
        request.on('end', () => response.writeHead(request.method === 'HEAD' ? 404 : 200).end());
      },
      (timing) => timings.push(timing),
    );
    await s3.write(key, bytes);
    expect(received).toEqual(['HEAD', 'PUT']);
    expect(timings.map((timing) => [timing.stage, timing.ok, timing.bytes])).toEqual([
      ['storage.s3.hash', true, bytes.byteLength],
      ['storage.s3.head', false, undefined],
      ['storage.s3.checksum', true, bytes.byteLength],
      ['storage.s3.put', true, bytes.byteLength],
    ]);
    for (const timing of timings) {
      expect(timing.ms).toBeGreaterThanOrEqual(0);
      expect(Object.keys(timing).sort()).toEqual(
        timing.bytes === undefined ? ['ms', 'ok', 'stage'] : ['bytes', 'ms', 'ok', 'stage'],
      );
    }
  });
  it('mede GET com o consumo do corpo e reutiliza objeto íntegro sem PUT', async () => {
    const timings: SemogStageTiming[] = [];
    const received: string[] = [];
    const s3 = await store(
      (request, response) => {
        received.push(request.method ?? '');
        response.writeHead(200, { 'Content-Length': bytes.byteLength, 'Content-Type': 'application/pdf' });
        response.end(request.method === 'HEAD' ? undefined : bytes);
      },
      (timing) => timings.push(timing),
    );
    await s3.write(key, bytes);
    expect(received).toEqual(['HEAD', 'GET']);
    expect(timings.map((timing) => timing.stage)).toEqual([
      'storage.s3.hash',
      'storage.s3.head',
      'storage.s3.read',
      'storage.s3.hash',
      'storage.s3.confirm.readback',
    ]);
    expect(timings.find((timing) => timing.stage === 'storage.s3.read')).toMatchObject({
      ok: true,
      bytes: bytes.byteLength,
    });
  });
  it('preserva erro original de leitura mesmo se observer falhar', async () => {
    const original = new Error('falha sintética');
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(original);
    const timings: SemogStageTiming[] = [];
    const s3 = createSemogS3PdfStore({ bucket: 'local' }, (timing) => {
      timings.push(timing);
      throw new Error('observer indisponível');
    });
    await expect(s3.read(key)).rejects.toBe(original);
    expect(timings).toEqual([{ stage: 'storage.s3.read', ms: expect.any(Number), ok: false }]);
  });
  it('observer que falha não muda sucesso nem conversão existente de erro no PUT', async () => {
    const s3 = await store(
      (request, response) => {
        request.resume();
        request.on('end', () => response.writeHead(request.method === 'HEAD' ? 404 : 403).end());
      },
      () => {
        throw new Error('observer indisponível');
      },
    );
    await expect(s3.write(key, bytes)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('recusada pelo armazenamento'),
    });
    const good = await store(
      (request, response) => {
        request.resume();
        request.on('end', () => response.writeHead(request.method === 'HEAD' ? 404 : 200).end());
      },
      () => {
        throw new Error('observer indisponível');
      },
    );
    await expect(good.write(key, bytes)).resolves.toBeUndefined();
  });
});

describe('Confirmação remota por checksum', () => {
  const checksum = createHash('sha256').update(bytes).digest('base64');
  it('pede checksum no HEAD e prova tamanho/hash sem GET', async () => {
    const methods: string[] = [];
    const stages: string[] = [];
    const s3 = await store(
      (request, response) => {
        methods.push(request.method ?? '');
        expect(request.headers['x-amz-checksum-mode']).toBe('ENABLED');
        response.writeHead(200, { 'Content-Length': bytes.byteLength, 'x-amz-checksum-sha256': checksum }).end();
      },
      (timing) => stages.push(timing.stage),
    );
    await s3.confirm?.(key, bytes);
    expect(methods).toEqual(['HEAD']);
    expect(stages).toContain('storage.s3.confirm.head-checksum');
  });
  it('sem checksum, relê o remoto e registra o fallback', async () => {
    const methods: string[] = [];
    const stages: string[] = [];
    const s3 = await store(
      (request, response) => {
        methods.push(request.method ?? '');
        response.writeHead(200, { 'Content-Length': bytes.byteLength });
        response.end(request.method === 'HEAD' ? undefined : bytes);
      },
      (timing) => stages.push(timing.stage),
    );
    await s3.confirm?.(key, bytes);
    expect(methods).toEqual(['HEAD', 'GET']);
    expect(stages).toContain('storage.s3.confirm.readback');
  });
  it.each(['checksum', 'length'])('recusa divergência de %s sem esconder com GET', async (field) => {
    const methods: string[] = [];
    const s3 = await store((request, response) => {
      methods.push(request.method ?? '');
      response
        .writeHead(200, {
          'Content-Length': field === 'length' ? bytes.byteLength + 1 : bytes.byteLength,
          'x-amz-checksum-sha256': field === 'checksum' ? Buffer.alloc(32).toString('base64') : checksum,
        })
        .end();
    });
    await expect(s3.confirm?.(key, bytes)).rejects.toMatchObject({ statusCode: 409 });
    expect(methods).toEqual(['HEAD']);
  });
  it('fallback recusa bytes adulterados mesmo com o tamanho esperado', async () => {
    const s3 = await store((request, response) => {
      response.writeHead(200, { 'Content-Length': bytes.byteLength });
      response.end(request.method === 'HEAD' ? undefined : Buffer.alloc(bytes.byteLength));
    });
    await expect(s3.confirm?.(key, bytes)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('S3 real com cache local descartável', () => {
  const withCache = async (run: (cache: ReturnType<typeof createSemogPdfDiskCache>) => Promise<void>) => {
    const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'semog-s3-cache-'));
    const cache = createSemogPdfDiskCache({ enabled: true, directory, minFreeBytes: 0 });
    try {
      await run(cache);
    } finally {
      cache.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
  it('HEAD 501 cai para GET remoto mesmo com cache quente, na confirmação e no replay', async () => {
    await withCache(async (cache) => {
      await cache.write(key, bytes);
      const seen: string[] = [];
      const stages: string[] = [];
      const endpoint = await fakeS3((request, response) => {
        seen.push(request.method ?? '');
        if (request.method === 'HEAD') {
          response.writeHead(501).end();
          return;
        }
        response.writeHead(200, { 'Content-Length': bytes.byteLength }).end(bytes);
      });
      const s3 = createSemogS3PdfStore(
        {
          bucket: 'local',
          endpoint,
          forcePathStyle: true,
          credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
          cache,
        },
        (timing) => stages.push(timing.stage),
      );
      await s3.confirm?.(key, bytes);
      await s3.write(key, bytes);
      expect(seen).toEqual(['HEAD', 'GET', 'HEAD', 'GET']);
      expect(stages.filter((stage) => stage === 'storage.s3.confirm.readback')).toHaveLength(2);
    });
  });
  it('HEAD 403 preserva erro sem tentar GET na confirmação e no replay', async () => {
    const seen: string[] = [];
    const s3 = await store((request, response) => {
      seen.push(request.method ?? '');
      response.writeHead(403).end();
    });
    await expect(s3.confirm?.(key, bytes)).rejects.toBeDefined();
    await expect(s3.write(key, bytes)).rejects.toBeDefined();
    expect(seen).toEqual(['HEAD', 'HEAD']);
  });
  it('PUT íntegro semeia cache; confirmação sem checksum ignora o cache quente', async () => {
    await withCache(async (cache) => {
      const seen: string[] = [];
      let stored = false;
      const endpoint = await fakeS3((request, response) => {
        seen.push(request.method ?? '');
        request.resume();
        request.on('end', () => {
          if (request.method === 'HEAD') {
            response.writeHead(stored ? 200 : 404, { 'Content-Length': bytes.byteLength }).end();
            return;
          }
          if (request.method === 'PUT') {
            stored = true;
            response.writeHead(200).end();
            return;
          }
          response.writeHead(200, { 'Content-Length': bytes.byteLength }).end(bytes);
        });
      });
      const s3 = createSemogS3PdfStore({
        bucket: 'local',
        endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
        cache,
      });
      await s3.write(key, bytes);
      expect(await s3.read(key)).toEqual(bytes);
      expect(seen).toEqual(['HEAD', 'PUT']);
      await s3.confirm?.(key, bytes);
      expect(seen).toEqual(['HEAD', 'PUT', 'HEAD', 'GET']);
    });
  });
  it('PUT falho não semeia cache', async () => {
    await withCache(async (cache) => {
      const write = vi.spyOn(cache, 'write');
      const endpoint = await fakeS3((request, response) => {
        request.resume();
        request.on('end', () => response.writeHead(request.method === 'HEAD' ? 404 : 403).end());
      });
      const s3 = createSemogS3PdfStore({
        bucket: 'local',
        endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
        cache,
      });
      await expect(s3.write(key, bytes)).rejects.toMatchObject({ statusCode: 409 });
      expect(write).not.toHaveBeenCalled();
    });
  });
  it('replay usa HEAD com checksum sem GET nem PUT', async () => {
    const seen: string[] = [];
    const s3 = await store((request, response) => {
      seen.push(request.method ?? '');
      response
        .writeHead(200, {
          'Content-Length': bytes.byteLength,
          'x-amz-checksum-sha256': createHash('sha256').update(bytes).digest('base64'),
        })
        .end();
    });
    await s3.write(key, bytes);
    expect(seen).toEqual(['HEAD']);
  });
  it('GETs brutos simultâneos coalescem sem compartilhar buffer', async () => {
    let reads = 0;
    const s3 = await store((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Length': bytes.byteLength }).end();
        return;
      }
      reads++;
      setTimeout(() => response.writeHead(200, { 'Content-Length': bytes.byteLength }).end(bytes), 30);
    });
    const [first, second] = await Promise.all([s3.read(key), s3.read(key), s3.confirm?.(key, bytes)]);
    expect(reads).toBe(1);
    first[0] = 0;
    expect(second[0]).toBe(bytes[0]);
  });
});
