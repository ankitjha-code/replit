import { useEffect, useState } from 'react';

export interface InPageNavItem {
  id: string;
  label: string;
}

const CURRENT_OFFSET_PX = 96;

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
