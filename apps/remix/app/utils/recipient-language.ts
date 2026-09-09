type LanguageDependencies<Language extends string> = {
  basePath: string;
  getLanguage: (lookup: 'recipient' | 'directLink', token: string) => Promise<unknown>;
  isSupportedLanguage: (value: unknown) => value is Language;
  onFailure: () => void;
};

/** Keep document locale scoped to recipient routes, including React Router data requests. */
export const resolveRecipientLanguage = async <Language extends string>(
  request: Request,
  dependencies: LanguageDependencies<Language>,
): Promise<Language | null> => {
  try {
    const basePath = dependencies.basePath.replace(/\/+$/, '');
    const pathname = new URL(request.url).pathname.replace(/\.data$/, '');
    if (basePath && !pathname.startsWith(`${basePath}/`)) {
      return null;
    }
    const route = pathname.slice(basePath.length).match(/^\/(sign|d)\/([^/]+)(?:\/|$)/);
    if (!route) {
      return null;
    }
    const token = decodeURIComponent(route[2]);
    const language = await dependencies.getLanguage(route[1] === 'sign' ? 'recipient' : 'directLink', token);
    return dependencies.isSupportedLanguage(language) ? language : null;
  } catch {
    // The adapter reports a generic failure without logging a recipient's private token.
    dependencies.onFailure();
    return null;
  }
};

/** A signing link changes rendering, never the visitor's persisted preference. */
export const selectRecipientLocale = <Language extends string>(
  documentLanguage: Language | null,
  cookieLanguage: Language,
) => ({ language: documentLanguage ?? cookieLanguage, cookieLanguage });
