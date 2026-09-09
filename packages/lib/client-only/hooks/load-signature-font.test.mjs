import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSignatureFont } from './load-signature-font.ts';

test('waits for the requested font before reporting ready', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  let settled = false;
  const result = loadSignatureFont({ load: () => pending }, '18px Caveat').then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  finish([{ status: 'loaded' }]);
  assert.equal(await result, true);
});
test('does not accept missing font faces or failed requests', async () => {
  assert.equal(await loadSignatureFont({ load: async () => [] }, '18px Missing'), false);
  assert.equal(
    await loadSignatureFont(
      {
        load: () => Promise.reject(new Error('offline')),
      },
      '18px Caveat',
    ),
    false,
  );
});
test('bounds loading and permits a fresh retry', async () => {
  assert.equal(await loadSignatureFont({ load: () => new Promise(() => {}) }, '18px Caveat', 10), false);
  assert.equal(await loadSignatureFont({ load: async () => [{ status: 'loaded' }] }, '18px Caveat'), true);
});

test('only loads Noto fonts needed by the signature script', async () => {
  const { getRequiredSignatureFontFamilies } = await import('./load-signature-font.ts');
  const family = '"Noto Sans", "Noto Sans Chinese", "Noto Sans Japanese", "Noto Sans Korean", sans-serif';
  assert.deepEqual(getRequiredSignatureFontFamilies('Caveat', 'Leandro'), ['Caveat']);
  assert.deepEqual(getRequiredSignatureFontFamilies(family, 'João'), ['"Noto Sans"']);
  assert.deepEqual(getRequiredSignatureFontFamilies(family, '李明'), ['"Noto Sans"', '"Noto Sans Chinese"']);
  assert.deepEqual(getRequiredSignatureFontFamilies(family, '김'), ['"Noto Sans"', '"Noto Sans Korean"']);
});
