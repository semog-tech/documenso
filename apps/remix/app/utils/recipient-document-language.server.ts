import { getBasePath } from '@documenso/lib/constants/app';
import { isValidLanguageCode, type SupportedLanguageCodes } from '@documenso/lib/constants/i18n';
import { prisma } from '@documenso/prisma';
import { resolveRecipientLanguage } from './recipient-language';

/**
 * Resolve the UI language for an anonymous recipient from the *document's*
 * configured language (`DocumentMeta.language`) instead of the browser's
 * `accept-language` header.
 *
 * Documenso normally derives the SSR locale from the `lang` cookie /
 * accept-language (see `extractLocaleData`), which leaves the public signing
 * page in English even when the document was created as e.g. `pt-BR`.
 *
 * This helper is intentionally scoped: it ONLY returns a language for the
 * recipient signing routes (`/sign/...`, `/d/...`). For every other route it
 * returns `null`, so the caller falls back to the existing locale resolution
 * and global behaviour is untouched.
 *
 * Returns a supported language code, or `null` when:
 *   - the request is not a signing route,
 *   - no document is found for the token,
 *   - the stored language is missing / not in `SUPPORTED_LANGUAGE_CODES`.
 */
export const getRecipientDocumentLanguage = (request: Request): Promise<SupportedLanguageCodes | null> => {
  return resolveRecipientLanguage(request, {
    basePath: getBasePath(),
    isSupportedLanguage: isValidLanguageCode,
    onFailure: () => console.warn('[recipient-i18n] Unable to resolve document language; using visitor locale.'),
    getLanguage: (lookup, token) =>
      lookup === 'recipient'
        ? prisma.recipient
            .findFirst({
              where: { token },
              select: { envelope: { select: { documentMeta: { select: { language: true } } } } },
            })
            .then((r) => r?.envelope?.documentMeta?.language ?? null)
        : prisma.templateDirectLink
            .findFirst({
              where: { token },
              select: { envelope: { select: { documentMeta: { select: { language: true } } } } },
            })
            .then((d) => d?.envelope?.documentMeta?.language ?? null),
  });
};
