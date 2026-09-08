interface PanelProps {
  title: string;
  /** Rendered at the right of the panel's title bar. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * One region of the workspace: a title bar and a body.
 *
 * A labelled region rather than a plain box, so someone navigating by landmark
 * can move between the explorer, the editor and the console directly.
 */
export function Panel({ title, actions, children }: PanelProps): React.JSX.Element {
  return (
    <section className="panel-frame" aria-label={title}>
      <header className="panel-frame__bar">
        <h2 className="panel-frame__title">{title}</h2>
        {actions && <div className="panel-frame__actions">{actions}</div>}
      </header>
      <div className="panel-frame__body">{children}</div>
    </section>
  );
}

interface PanelPlaceholderProps {
  headline: string;
  detail: string;
}

/**
 * What a panel shows before the capability behind it exists.
 *
 * Deliberately plain text rather than a disabled imitation of the real thing.
 * A greyed-out editor or an empty file tree would suggest the feature is
 * present and broken, which is a worse thing to tell someone than the truth.
 */
export function PanelPlaceholder({ headline, detail }: PanelPlaceholderProps): React.JSX.Element {
  return (
    <div className="panel-placeholder">
      <p className="panel-placeholder__headline">{headline}</p>
      <p className="panel-placeholder__detail">{detail}</p>
    </div>
  );
}
