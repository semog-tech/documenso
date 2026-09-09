import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getRecipientAppearance } from './recipient-appearance.ts';
import { resolveRecipientLanguage, selectRecipientLocale } from './recipient-language.ts';

const request = (path) =>
  new Request(`https://sign.example${path}`, { headers: { 'accept-language': 'en', cookie: 'lang=en' } });
const deps = (language = 'pt-BR') => ({
  basePath: '',
  getLanguage: () => Promise.resolve(language),
  isSupportedLanguage: (value) => ['pt-BR', 'en', 'de'].includes(value),
  onFailure: () => {},
});

describe('Semog recipient locale', () => {
  it('document language wins while cookie preference remains unchanged', async () => {
    const documentLanguage = await resolveRecipientLanguage(request('/sign/token'), deps());
    assert.deepEqual(selectRecipientLocale(documentLanguage, 'en'), { language: 'pt-BR', cookieLanguage: 'en' });
  });
  it('does not query documents on an account route', async () => {
    let queries = 0;
    const d = deps();
    d.getLanguage = () => {
      queries += 1;
      return Promise.resolve('pt-BR');
    };
    assert.equal(await resolveRecipientLanguage(request('/settings/profile'), d), null);
    assert.equal(queries, 0);
  });
  it('supports subpaths and nested signing pages without querying a similar prefix', async () => {
    const seen = [];
    const d = {
      ...deps(),
      basePath: '/ESign',
      getLanguage: (lookup, token) => {
        seen.push([lookup, token]);
        return Promise.resolve('pt-BR');
      },
    };
    assert.equal(await resolveRecipientLanguage(request('/ESign/sign/abc%2D123/complete'), d), 'pt-BR');
    assert.equal(await resolveRecipientLanguage(request('/ESign/d/direct'), d), 'pt-BR');
    assert.equal(await resolveRecipientLanguage(request('/ESign/sign/data-token.data'), d), 'pt-BR');
    assert.equal(await resolveRecipientLanguage(request('/ESignature/sign/no'), d), null);
    assert.deepEqual(seen, [
      ['recipient', 'abc-123'],
      ['directLink', 'direct'],
      ['recipient', 'data-token'],
    ]);
  });
  it('falls back for unsupported or missing language', async () => {
    for (const value of ['xx', null]) {
      const language = await resolveRecipientLanguage(request('/sign/token'), deps(value));
      assert.deepEqual(selectRecipientLocale(language, 'en'), { language: 'en', cookieLanguage: 'en' });
    }
  });
  it('reports lookup failure without exposing the token or breaking signing', async () => {
    let failures = 0;
    const d = {
      ...deps(),
      getLanguage: () => Promise.reject(new Error('database')),
      onFailure: () => {
        failures += 1;
      },
    };
    assert.equal(await resolveRecipientLanguage(request('/sign/private-token'), d), null);
    assert.equal(failures, 1);
  });
  it('rejects malformed encoded token before database access', async () => {
    let failures = 0;
    const d = {
      ...deps(),
      onFailure: () => {
        failures += 1;
      },
    };
    assert.equal(await resolveRecipientLanguage(request('/sign/%ZZ'), d), null);
    assert.equal(failures, 1);
  });
});

describe('Semog recipient appearance', () => {
  it('ignores a dark provider update on recipient routes and preserves it elsewhere', () => {
    const matches = [{ id: 'routes/_recipient+/sign.$token+/_index' }];
    assert.equal(getRecipientAppearance(matches, 'light', 'dark').theme, 'light');
    assert.deepEqual(getRecipientAppearance([], 'light', 'dark'), {
      isRecipientRoute: false,
      theme: 'dark',
      ssrTheme: true,
    });
    assert.deepEqual(getRecipientAppearance([], null, 'dark'), {
      isRecipientRoute: false,
      theme: 'dark',
      ssrTheme: false,
    });
  });
  it('forces light and suppresses system-theme flashing only for recipient routes', () => {
    const matches = [{ id: 'root' }, { id: 'routes/_recipient+/sign.$token+/_index' }];
    assert.deepEqual(getRecipientAppearance(matches, 'dark'), {
      isRecipientRoute: true,
      theme: 'light',
      ssrTheme: true,
    });
    assert.deepEqual(getRecipientAppearance(matches, null), { isRecipientRoute: true, theme: 'light', ssrTheme: true });
  });
  it('retains stored or system theme on dashboard and similarly named routes', () => {
    assert.deepEqual(getRecipientAppearance([], undefined), { isRecipientRoute: false, theme: null, ssrTheme: false });
    assert.deepEqual(getRecipientAppearance([{ id: 'routes/dashboard' }], 'dark'), {
      isRecipientRoute: false,
      theme: 'dark',
      ssrTheme: true,
    });
    assert.deepEqual(getRecipientAppearance([{ id: 'routes/_recipient-settings' }], null), {
      isRecipientRoute: false,
      theme: null,
      ssrTheme: false,
    });
  });
});
