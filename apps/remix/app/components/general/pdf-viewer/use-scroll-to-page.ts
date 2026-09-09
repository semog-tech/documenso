import { type RefObject, useEffect } from 'react';

/**
 * Watch for `data-scroll-to-page` attribute changes on a container element.
 *
 * When set (by `validateFieldsInserted`, `handleOnNextFieldClick`, or similar),
 * scroll the virtual list to the requested page and clear the attribute.
 *
 * This is the communication bridge between field validation logic (which knows
 * which page to scroll to) and the virtual list (which knows how to scroll).
 */
export const useScrollToPage = (contentRef: RefObject<HTMLElement | null>, scrollToItem: (index: number) => void) => {
  useEffect(() => {
    const el = contentRef.current;

    if (!el) {
      return;
    }

    const consumeRequest = () => {
      const raw = el.getAttribute('data-scroll-to-page');
      if (!raw) {
        return;
      }
      const pageNumber = Number(raw);
      el.removeAttribute('data-scroll-to-page');
      if (Number.isInteger(pageNumber) && pageNumber >= 1) {
        // Pages are 1-indexed; virtual list items are 0-indexed.
        scrollToItem(pageNumber - 1);
      }
    };
    const observer = new MutationObserver(consumeRequest);
    observer.observe(el, { attributes: true, attributeFilter: ['data-scroll-to-page'] });
    // A request can arrive between the DOM commit and this effect registering.
    consumeRequest();
    return () => observer.disconnect();
  }, [contentRef, scrollToItem]);
};
