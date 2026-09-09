import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('./remark-page.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { waitForRemarkPage } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);

const setup = (context) => {
  const operation = new AbortController();
  const originals = Object.fromEntries(
    ['document', 'HTMLImageElement', 'MutationObserver'].map((key) => [key, globalThis[key]]),
  );
  context.after(() => {
    operation.abort();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete globalThis[key];
      } else {
        globalThis[key] = value;
      }
    }
  });
  let check;
  let disconnected = 0;
  class Image {
    complete = true;
    naturalWidth = 600;
    scrollIntoView() {}
  }
  let firstPage = null;
  let targetPage = null;
  const requests = [];
  const content = {
    setAttribute: (key, value) => requests.push([key, value]),
    querySelector: (selector) => (selector.includes('data-page-number') ? targetPage : firstPage),
  };
  globalThis.HTMLImageElement = Image;
  globalThis.MutationObserver = class {
    constructor(callback) {
      check = callback;
    }
    observe() {}
    disconnect() {
      disconnected += 1;
    }
  };
  globalThis.document = Object.assign(new EventTarget(), { body: {}, querySelector: () => content });
  return {
    operation,
    requests,
    check: () => check(),
    first: () => {
      firstPage = new Image();
    },
    target: () => {
      targetPage = new Image();
      return targetPage;
    },
    disconnected: () => disconnected,
  };
};

test('early click waits for a measured loaded page before requesting page 153', async (context) => {
  const dom = setup(context);
  const operation = dom.operation;
  const pending = waitForRemarkPage({
    pageNumber: 153,
    signal: operation.signal,
    previousContent: null,
    isCurrentItem: () => true,
  });

  assert.deepEqual(dom.requests, []);
  dom.first();
  dom.check();
  assert.deepEqual(dom.requests, [['data-scroll-to-page', '153']]);
  dom.check();
  assert.equal(dom.requests.length, 1);
  const target = dom.target();
  dom.check();
  assert.equal(await pending, target);
  assert.equal(dom.disconnected(), 1);
});

test('abort releases the observer without requesting an unloaded page', async (context) => {
  const dom = setup(context);
  const operation = dom.operation;
  const pending = waitForRemarkPage({
    pageNumber: 153,
    signal: operation.signal,
    previousContent: null,
    isCurrentItem: () => true,
  });
  operation.abort();
  assert.equal(await pending, null);
  assert.deepEqual(dom.requests, []);
  assert.equal(dom.disconnected(), 1);
});

test('timeout releases the observer and returns a retryable absence', async (context) => {
  const dom = setup(context);
  assert.equal(
    await waitForRemarkPage({
      pageNumber: 153,
      signal: new AbortController().signal,
      previousContent: null,
      isCurrentItem: () => true,
      timeoutMs: 5,
    }),
    null,
  );
  assert.equal(dom.disconnected(), 1);
});
