import type { ReactElement, ReactNode } from 'react';
import { IconButton } from '../ui/index.js';
import { ArrowsInSimple, ArrowsOutSimple } from '../ui/icons.js';

interface PanelProps {
  title: string;
  /** Rendered at the right of the panel's title bar, before the collapse control. */
  actions?: ReactNode;
  /** Hides the panel; the control is named "Hide {title}" (pinned by the tests). */
  onCollapse?: (() => void) | undefined;
  /** Anchors the region, for the "Skip to editor" link. */
  id?: string;
  /** Phone: the region stays mounted but is not shown. */
  hidden?: boolean;
  children: ReactNode;
}

/**
 * One region of the workspace: a 28px title bar and a body.
 *
 * A labelled region rather than a plain box, so someone navigating by landmark
 * can move between the explorer, the editor and the console directly.
 */
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

/**
 * A hidden panel's way back (design spec 9.9).
 *
 * A collapsed panel keeps a 28px rail with its name rather than disappearing
 * entirely, so nothing is lost with no way to bring it back. The control is
 * named "Show {title}", which the tests press.
 */
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
