import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { useAnalytics } from '@documenso/lib/client-only/hooks/use-analytics';
import { SessionProvider } from '@documenso/lib/client-only/providers/session';
import { getBasePath } from '@documenso/lib/constants/app';
import { APP_I18N_OPTIONS, type SupportedLanguageCodes } from '@documenso/lib/constants/i18n';
import { createPublicEnv } from '@documenso/lib/utils/env';
import { extractLocaleData } from '@documenso/lib/utils/i18n';
import { TrpcProvider } from '@documenso/trpc/react';
import { getOrganisationSession } from '@documenso/trpc/server/organisation-router/get-organisation-session';
import { Toaster } from '@documenso/ui/primitives/toaster';
import { TooltipProvider } from '@documenso/ui/primitives/tooltip';
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7';
import { useEffect } from 'react';
import {
  data,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useMatches,
} from 'react-router';
import { PreventFlashOnWrongTheme, ThemeProvider, useTheme } from 'remix-themes';
import { nonceMiddleware } from '~/middleware/nonce';
import type { Route } from './+types/root';
import stylesheet from './app.css?url';
import { GenericErrorLayout } from './components/general/generic-error-layout';
import { langCookie } from './storage/lang-cookie.server';
import { themeSessionResolver } from './storage/theme-session.server';
import { appMetaTags } from './utils/meta';
import { nonce, nonceContext } from './utils/nonce';
import { getRecipientAppearance } from './utils/recipient-appearance';
import { getRecipientDocumentLanguage } from './utils/recipient-document-language.server';
import { selectRecipientLocale } from './utils/recipient-language';

export const middleware = [nonceMiddleware];

export const links: Route.LinksFunction = () => [
  { rel: 'stylesheet', href: stylesheet },
  {
    rel: 'preload',
    href: '/fonts/saira-variablefont_wght.ttf',
    as: 'font',
    type: 'font/ttf',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'preload',
    href: '/fonts/caveat-variablefont_wght.ttf',
    as: 'font',
    type: 'font/ttf',
    crossOrigin: 'anonymous',
  },
];

export function meta() {
  return appMetaTags();
}

/**
 * Don't revalidate (run the loader on sequential navigations) on the root layout
 *
 * Update values via providers.
 */
export const shouldRevalidate = () => false;

export async function loader({ context, request }: Route.LoaderArgs) {
  const session = await getOptionalSession(request);

  const { getTheme } = await themeSessionResolver(request);

  const cookieHeader = request.headers.get('cookie') ?? '';

  // Resolve the persisted/browser locale first. This is what we keep storing in
  // the `lang` cookie so a recipient who later visits the rest of the app is not
  // permanently switched to a document's language.
  let cookieLang: SupportedLanguageCodes = await langCookie.parse(cookieHeader);

  if (!APP_I18N_OPTIONS.supportedLangs.includes(cookieLang)) {
    cookieLang = extractLocaleData({ headers: request.headers }).lang;
  }

  // For the public signing routes, the rendered UI language (and therefore the
  // `<html lang>` attribute that drives client-side hydration in
  // `entry.client.tsx`) follows the document's configured language. Returns
  // `null` everywhere else, so non-signing routes keep the cookie/browser lang.
  const documentLang = await getRecipientDocumentLanguage(request);

  const { language: lang, cookieLanguage } = selectRecipientLocale(documentLang, cookieLang);

  const disableAnimations = cookieHeader.includes('__disable_animations=true');

  let organisations = null;

  if (session.isAuthenticated) {
    organisations = await getOrganisationSession({ userId: session.user.id });
  }

  return data(
    {
      lang,
      theme: getTheme(),
      disableAnimations,
      basePath: getBasePath(),
      // Surface the per-request CSP nonce produced by `securityHeadersMiddleware` so all
      // SSR-rendered <script>/<style> elements in this layout (and child
      // routes that need it) can carry the matching nonce attribute.
      nonce: context.get(nonceContext),
      session: session.isAuthenticated
        ? {
            user: session.user,
            session: session.session,
            organisations: organisations || [],
          }
        : null,
      publicEnv: createPublicEnv(),
    },
    {
      headers: {
        // Persist the cookie/browser lang only — never the per-document signing
        // language — so visiting a `pt-BR` signing link doesn't permanently
        // change the recipient's locale for the rest of the app.
        'Set-Cookie': await langCookie.serialize(cookieLanguage),
      },
    },
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { theme, basePath } = useLoaderData<typeof loader>() || {};

  return (
    <ThemeProvider specifiedTheme={theme ?? null} themeAction={`${basePath ?? ''}/api/theme`}>
      <LayoutContent>{children}</LayoutContent>
    </ThemeProvider>
  );
}

export function LayoutContent({ children }: { children: React.ReactNode }) {
  const {
    publicEnv,
    session,
    lang,
    disableAnimations,
    nonce: cspNonce,
    ...data
  } = useLoaderData<typeof loader>() || {};

  const [theme] = useTheme();

  const basePath = data.basePath ?? '';

  // Recipient routes (signing pages) put `documenso-branded` on <body> so the
  // <style> block from `RecipientBranding` applies to BOTH the main tree and
  // any portaled content (Radix dialogs/popovers/dropdowns mount outside the
  // route tree, attached directly to document.body).
  const matches = useMatches();
  // The provider also follows BroadcastChannel/system updates. Recipient HTML
  // must stay light even if its hook changes after the initial render.
  const { isRecipientRoute, ssrTheme, theme: effectiveTheme } = getRecipientAppearance(matches, data.theme, theme);

  return (
    // `suppressHydrationWarning` because `remix-themes` intentionally mutates
    // `data-theme`/`class` on <html> before hydration (PreventFlashOnWrongTheme),
    // so the server-rendered attributes never match the client render when the
    // theme is resolved from the system preference. Attribute-only, one level deep.
    <html
      translate="no"
      lang={lang}
      data-theme={effectiveTheme}
      className={effectiveTheme ?? ''}
      suppressHydrationWarning
    >
      <head>
        <meta charSet="utf-8" />
        <link rel="apple-touch-icon" sizes="180x180" href={`${basePath}/semog-favicon-180-bff59b07ee56.png`} />
        <link rel="icon" type="image/png" sizes="32x32" href={`${basePath}/semog-favicon-32-bff59b07ee56.png`} />
        <link rel="icon" type="image/png" sizes="16x16" href={`${basePath}/semog-favicon-16-bff59b07ee56.png`} />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/svg+xml" sizes="any" href={`${basePath}/semog-favicon-bff59b07ee56.svg`} />
        <link rel="manifest" href={`${basePath}/site-bff59b07ee56.webmanifest`} />
        <meta name="google" content="notranslate" />
        <Meta />
        <Links nonce={nonce(cspNonce)} />
        <meta name="google" content="notranslate" />
        {isRecipientRoute ? (
          <meta name="color-scheme" content="light" />
        ) : (
          <PreventFlashOnWrongTheme ssrTheme={ssrTheme} nonce={nonce(cspNonce)} />
        )}

        {disableAnimations && (
          <style
            nonce={nonce(cspNonce)}
            dangerouslySetInnerHTML={{
              __html: `*, *::before, *::after { animation: none !important; transition: none !important; }`,
            }}
          />
        )}

        {/* Fix: https://stackoverflow.com/questions/21147149/flash-of-unstyled-content-fouc-in-firefox-only-is-ff-slow-renderer */}
        <script nonce={nonce(cspNonce)}>0</script>
      </head>
      <body className={isRecipientRoute ? 'documenso-branded' : undefined}>
        {/* Global license banner currently disabled. Need to wait until after a few releases. */}
        {/* {licenseStatus === '?' && (
          <div className="bg-destructive text-destructive-foreground">
            <div className="mx-auto flex h-auto max-w-screen-xl items-center justify-center px-4 py-3 text-sm font-medium">
              <div className="flex items-center">
                <AlertTriangleIcon className="mr-2 h-4 w-4" />
                <Trans>This is an expired license instance of Documenso</Trans>
              </div>
            </div>
          </div>
        )} */}

        <NuqsAdapter>
          <SessionProvider initialSession={session}>
            <TooltipProvider>
              <TrpcProvider>
                {children}

                <Toaster />
              </TrpcProvider>
            </TooltipProvider>
          </SessionProvider>
        </NuqsAdapter>

        <script
          nonce={nonce(cspNonce)}
          dangerouslySetInnerHTML={{
            // `__webpack_nonce__` is read by `get-nonce` (used by
            // react-remove-scroll / react-style-singleton inside Radix menus and
            // dialogs) to stamp runtime-injected <style> elements. Without it the
            // strict `style-src-elem` CSP blocks the scroll-lock styles.
            __html: `window.__ENV__ = ${JSON.stringify(publicEnv)}; window.__webpack_nonce__ = ${JSON.stringify(cspNonce ?? '')}`,
          }}
        />

        <ScrollRestoration nonce={nonce(cspNonce)} />
        <Scripts nonce={nonce(cspNonce)} />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const analytics = useAnalytics();

  const errorCode = isRouteErrorResponse(error) ? error.status : 500;

  if (errorCode !== 404) {
    console.error('[RootErrorBoundary]', error);
  }

  useEffect(() => {
    if (errorCode !== 404) {
      analytics.captureException(error, { source: 'app', location: 'root_boundary' });
    }
  }, [error]);

  return <GenericErrorLayout errorCode={errorCode} />;
}
