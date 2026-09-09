import { Theme } from 'remix-themes';

export const getRecipientAppearance = (
  matches: { id?: string }[],
  storedTheme: Theme | null | undefined,
  currentTheme: Theme | null | undefined = storedTheme,
) => {
  const isRecipientRoute = matches.some((match) => match.id?.startsWith('routes/_recipient+'));
  return {
    isRecipientRoute,
    theme: isRecipientRoute ? Theme.LIGHT : (currentTheme ?? null),
    ssrTheme: isRecipientRoute || Boolean(storedTheme),
  };
};
