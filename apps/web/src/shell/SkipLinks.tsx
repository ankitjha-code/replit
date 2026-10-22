import type { ReactElement } from 'react';

/**
 * The first focusable elements on every page: straight to the content, and in
 * the workspace straight to the editor. Visible only while focused.
 */
export function SkipLinks({ inWorkspace }: { inWorkspace: boolean }): ReactElement {
  return (
    <div className="skip-links">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      {inWorkspace ? (
        <a className="skip-link" href="#editor">
          Skip to editor
        </a>
      ) : null}
    </div>
  );
}
