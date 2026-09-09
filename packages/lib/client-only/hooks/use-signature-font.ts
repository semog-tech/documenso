import { useEffect, useState } from 'react';
import { loadSignatureFont } from './load-signature-font';

export const useSignatureFont = (font: string, enabled = true) => {
  const [state, setState] = useState<{ font: string; status: 'loading' | 'ready' | 'error' }>({
    font,
    status: 'loading',
  });
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let active = true;
    setState({ font, status: 'loading' });
    void loadSignatureFont(document.fonts, font).then((ready) => {
      if (active) {
        setState({ font, status: ready ? 'ready' : 'error' });
      }
    });
    return () => {
      active = false;
    };
  }, [font, enabled]);
  return {
    status: state.font === font ? state.status : 'loading',
    retry: () => window.location.reload(),
  };
};
