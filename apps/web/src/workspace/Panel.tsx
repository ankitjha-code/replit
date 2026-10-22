import type { ReactElement, ReactNode } from 'react';
import { IconButton } from '../ui/index.js';
import { ArrowsInSimple, ArrowsOutSimple } from '../ui/icons.js';

interface PanelProps {
  title: string;
  actions?: ReactNode;
  onCollapse?: (() => void) | undefined;
  id?: string;
  hidden?: boolean;
  children: ReactNode;
}

export function Panel({
  title,
  actions,
  onCollapse,
  id,
  hidden,
  children,
}: PanelProps): ReactElement {
  return (
    <section className="panel-frame" aria-label={title} id={id} hidden={hidden}>
      <header className="panel-frame__bar">
        <h2 className="panel-frame__title">{title}</h2>
        <div className="panel-frame__actions">
          {actions}
          {onCollapse ? (
            <IconButton
              size="sm"
              label={`Hide ${title.toLowerCase()}`}
              icon={ArrowsInSimple}
              className="panel-frame__collapse"
              onClick={onCollapse}
            />
          ) : null}
        </div>
      </header>
      <div className="panel-frame__body">{children}</div>
    </section>
  );
}

export function CollapsedRail({
  title,
  onExpand,
  horizontal = false,
}: {
  title: string;
  onExpand: () => void;
  horizontal?: boolean;
}): ReactElement {
  return (
    <div className={`collapsed-rail${horizontal ? ' collapsed-rail--horizontal' : ''}`}>
      <span className="collapsed-rail__label" aria-hidden="true">
        {title}
      </span>
      <IconButton
        size="sm"
        label={`Show ${title.toLowerCase()}`}
        icon={ArrowsOutSimple}
        className="collapsed-rail__button"
        onClick={onExpand}
      />
    </div>
  );
}
