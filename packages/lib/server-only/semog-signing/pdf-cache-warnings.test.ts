import { expect, it, vi } from 'vitest';

import { createSemogPdfCacheWarningObserver } from './pdf-cache-warnings';

it('limita avisos repetidos a um por minuto por motivo, sem suprimir outro motivo', () => {
  let now = 0;
  const emit = vi.fn();
  const warn = createSemogPdfCacheWarningObserver(emit, () => now);
  warn('low-space');
  warn('low-space');
  warn('corrupt');
  now = 59_999;
  warn('low-space');
  expect(emit.mock.calls).toEqual([['low-space'], ['corrupt']]);
  now = 60_000;
  warn('low-space');
  warn('corrupt');
  expect(emit.mock.calls).toEqual([['low-space'], ['corrupt'], ['low-space'], ['corrupt']]);
});
