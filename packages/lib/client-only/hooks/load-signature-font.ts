type FontLoader = { load: (font: string) => Promise<Array<{ status: string }>> };

/** An empty result means the requested face is absent, even when fonts.check succeeds. */
export const loadSignatureFont = async (fonts: FontLoader, font: string, timeoutMs = 10000): Promise<boolean> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fonts.load(font).then((faces) => faces.length > 0 && faces.every((face) => face.status === 'loaded')),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    // A failed face must never be presented as a successfully loaded fallback.
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

/** Keep the renderer's family order while avoiding unrelated CJK downloads. */
export const getRequiredSignatureFontFamilies = (family: string, text: string): string[] =>
  family
    .split(',')
    .map((value) => value.trim())
    .filter((value) => {
      if (value === 'sans-serif') {
        return false;
      }
      if (value === '"Noto Sans Chinese"') {
        return /\p{Script=Han}/u.test(text);
      }
      if (value === '"Noto Sans Japanese"') {
        return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
      }
      if (value === '"Noto Sans Korean"') {
        return /\p{Script=Hangul}/u.test(text);
      }
      return true;
    });
