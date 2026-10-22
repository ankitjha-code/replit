import { useEffect, useState } from 'react';

export interface InPageNavItem {
  /** The id of the section element this entry scrolls to. */
  id: string;
  label: string;
}

/** How far below the top of the viewport a section counts as the current one. */
const CURRENT_OFFSET_PX = 96;

/**
 * A table of contents for a page holding more than one section.
 *
 * Plain anchors rather than tabs, deliberately: this is the third thing on
 * screen that names places (after the primary nav and the settings sidebar),
 * and a third navigation level would be the "ten flat tabs" problem again.
 * The current entry follows scrolling so the person can see where they are.
 */
export function InPageNav({ items }: { items: InPageNavItem[] }): React.JSX.Element {
  const [current, setCurrent] = useState<string | undefined>(items[0]?.id);

  useEffect(() => {
    let frame: number | undefined;
    const update = (): void => {
      frame = undefined;
      let found: string | undefined;
      for (const item of items) {
        const element = document.getElementById(item.id);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= CURRENT_OFFSET_PX) found = item.id;
      }
      setCurrent(found ?? items[0]?.id);
    };
    const onScroll = (): void => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    update();
    // Captured at the document, because the shell's main column scrolls
    // rather than the window, and that may change again.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [items]);

  return (
    <nav aria-label="On this page" className="settings-toc">
      {items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          className="settings-toc__link"
          aria-current={current === item.id ? 'location' : undefined}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
