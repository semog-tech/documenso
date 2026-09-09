import { PDF_VIEWER_CONTENT_SELECTOR, PDF_VIEWER_PAGE_SELECTOR } from '@documenso/lib/constants/pdf-viewer';

type RemarkPageOptions = {
  pageNumber: number;
  signal: AbortSignal;
  isCurrentItem: () => boolean;
  previousContent: Element | null;
  timeoutMs?: number;
};
/** Wait for the new PDF item's actual page image, including virtualised pages. */
export const waitForRemarkPage = (options: RemarkPageOptions): Promise<HTMLElement | null> =>
  new Promise((resolve) => {
    const signalled = new WeakSet<Element>();
    let settled = false;
    const finish = (page: HTMLElement | null) => {
      if (settled) {
        return;
      }
      settled = true;
      observer.disconnect();
      clearTimeout(timeout);
      document.removeEventListener('load', check, true);
      options.signal.removeEventListener('abort', abort);
      resolve(page);
    };
    const check = () => {
      const content = document.querySelector(PDF_VIEWER_CONTENT_SELECTOR);
      if (!options.isCurrentItem() || !content || content === options.previousContent) {
        return;
      }
      // A page image only loads after the virtual list has measured its width.
      const firstPage = content.querySelector(PDF_VIEWER_PAGE_SELECTOR);
      if (!(firstPage instanceof HTMLImageElement) || !firstPage.complete || firstPage.naturalWidth === 0) {
        return;
      }
      if (!signalled.has(content)) {
        signalled.add(content);
        content.setAttribute('data-scroll-to-page', String(options.pageNumber));
      }
      const page = content.querySelector(`${PDF_VIEWER_PAGE_SELECTOR}[data-page-number="${options.pageNumber}"]`);
      if (page instanceof HTMLImageElement && page.complete && page.naturalWidth > 0) {
        page.scrollIntoView({ behavior: 'instant', block: 'center' });
        finish(page);
      }
    };
    const abort = () => finish(null);
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => finish(null), options.timeoutMs ?? 45_000);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-page-count'],
    });
    document.addEventListener('load', check, true);
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) {
      finish(null);
    } else {
      check();
    }
  });
