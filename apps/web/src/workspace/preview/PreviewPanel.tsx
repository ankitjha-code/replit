import { useEffect } from 'react';
import type { RuntimeStateResponse } from '@platform/shared';
import { PanelPlaceholder } from '../Panel.js';
import { usePreview } from './use-preview.js';

/**
 * The preview: the project's own application, in a frame.
 *
 * The frame points at a different origin on purpose. What a project serves is
 * code the platform did not write, and on the platform's origin it could read
 * the API as the person looking at it. That separation is also why the frame
 * needs an address minted by the server rather than one built here.
 */
export function PreviewPanel({
  projectId,
  runtime,
  runNonce,
}: {
  projectId: string;
  runtime: RuntimeStateResponse | undefined;
  /**
   * Changes whenever the application starts or stops.
   *
   * What a project serves appears and disappears with the program inside the
   * container, not with the container, so the preview has to look again at
   * exactly those moments rather than waiting out a poll.
   */
  runNonce?: number;
}): React.JSX.Element {
  const running = runtime?.runtime?.status === 'RUNNING';
  const preview = usePreview(projectId, running);
  const { state, entryUrl, tabUrl, open } = preview;

  const ready = running && state?.url !== null && state?.url !== undefined;

  // Asked for as soon as there is something to show, so nobody has to press a
  // button to see a page that is already serving.
  useEffect(() => {
    if (ready && !entryUrl) void open();
  }, [ready, entryUrl, open]);

  // The application started or stopped. What a project serves goes with it, so
  // the answer from a moment ago is no longer the answer.
  useEffect(() => {
    if (runNonce === undefined) return;
    void preview.refresh();
    // The nonce and the read itself, which is stable for a project. Depending
    // on the whole hook would refresh on every render, which is a poll.
  }, [runNonce, preview.refresh]);

  if (!ready) {
    return (
      <PanelPlaceholder
        headline={running ? 'Nothing to preview yet' : 'Nothing to preview'}
        detail={
          preview.loading
            ? 'Checking what this project is serving…'
            : (state?.reason ?? 'Start the project to see a preview of it.')
        }
      />
    );
  }

  return (
    <div className="preview-panel">
      <div className="preview-panel__bar">
        <span className="preview-panel__address" title={state.url ?? undefined}>
          {/* The port the application was actually found on, not one assumed. */}
          port {state.port}
        </span>
        <span className="preview-panel__spacer" />
        <button type="button" className="icon-button" onClick={() => void open()}>
          Reload
        </button>
        {tabUrl && (
          <a
            className="icon-button"
            href={tabUrl}
            target="_blank"
            rel="noreferrer"
            // A tab is always available, and is the only option when the
            // browser will not carry the preview's cookie into a frame.
            title="Open this preview in a new tab"
          >
            Open in a tab
          </a>
        )}
      </div>

      {preview.error && (
        <p className="preview-panel__message" role="alert">
          {preview.error}
        </p>
      )}

      {!state.framable ? (
        <p className="preview-panel__message">
          This installation is served over plain HTTP, so the browser will not carry the
          preview&rsquo;s cookie into a frame. Open it in a tab.
        </p>
      ) : entryUrl ? (
        <iframe
          className="preview-panel__frame"
          title="Project preview"
          src={entryUrl}
          /*
           * Sandboxed, and deliberately not with allow-same-origin removed:
           * the preview is already on its own origin, and taking the origin
           * away as well would break every application that uses storage or
           * a service worker. What is withheld is the ability to reach out of
           * the frame: no top-level navigation, no downloads triggered at the
           * platform's expense.
           */
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      ) : (
        <p className="preview-panel__message">Opening the preview…</p>
      )}
    </div>
  );
}
