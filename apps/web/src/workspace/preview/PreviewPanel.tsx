import { useEffect, useId, useState } from 'react';
import { PREVIEW_CANDIDATE_PORTS, type RuntimeStateResponse } from '@platform/shared';
import { createPreviewGrant } from '../../lib/preview-api.js';
import { useAuth } from '../../lib/auth-context.js';
import { markPreviewOpened } from '../../onboarding/use-onboarding.js';
import { Button, Callout, EmptyState, Progress, Skeleton, Spinner } from '../../ui/index.js';
import { ArrowSquareOut, Browser, ShareNetwork } from '../../ui/icons.js';
import { useWorkspaceActions } from '../shell/workspace-actions.js';
import {
  OpenInTabLink,
  PHONE_PREVIEW_WIDTH,
  PreviewBar,
  type PreviewDevice,
} from './PreviewBar.js';
import { usePreview } from './use-preview.js';
import './preview.css';

/** How long a frame may take to load before the panel says so (spec 9.8). */
export const SLOW_FRAME_MS = 8_000;

export const STOPPED_TEXT =
  'Start the environment, then run the app. The preview appears when it listens on a port.';

const WATCHED_PORTS = `The preview looks on ports ${PREVIEW_CANDIDATE_PORTS.slice(0, -1).join(', ')} and ${PREVIEW_CANDIDATE_PORTS.at(-1)}.`;

const STARTING = new Set(['REQUESTED', 'CREATING', 'STARTING']);

/**
 * The preview: the project's own app, in a frame or a tab.
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
  canShare = false,
}: {
  projectId: string;
  runtime: RuntimeStateResponse | undefined;
  /**
   * Changes whenever the app starts or stops.
   *
   * What a project serves appears and disappears with the program inside the
   * environment, not with the environment, so the preview has to look again
   * at exactly those moments rather than waiting out a poll.
   */
  runNonce?: number;
  /** May make preview links, so the preview offers Share. */
  canShare?: boolean;
}): React.JSX.Element {
  const actions = useWorkspaceActions();
  const { user } = useAuth();
  const status = runtime?.runtime?.status;
  const running = status === 'RUNNING';
  const preview = usePreview(projectId, running, runNonce ?? actions.runNonce);
  const { state, entryUrl, tabUrl, error, open } = preview;

  const ready = running && typeof state?.url === 'string' && state.port !== null;
  const framable = state?.framable ?? true;

  // Asked for as soon as there is something to show, so nobody has to press a
  // button to see a page that is already serving.
  useEffect(() => {
    if (ready && !tabUrl && !error) void open();
  }, [ready, tabUrl, error, open]);

  // The frame decides the preview column's default width (spec 9.9).
  const { reportPreview } = actions;
  useEffect(() => {
    reportPreview({ listening: ready, framable });
  }, [ready, framable, reportPreview]);
  useEffect(() => () => reportPreview(null), [reportPreview]);

  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const opened = (): void => {
    if (user) markPreviewOpened(user.id);
  };

  if (!running) return <Stopped status={status} available={runtime?.provider.available} />;

  if (!state) {
    if (preview.readFailed) {
      return (
        <div className="preview-panel__center">
          <Callout
            tone="danger"
            title="Could not check what this project is serving."
            action={
              <Button size="sm" onClick={() => void preview.refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="preview-panel" aria-busy="true">
        <span className="visually-hidden">Checking what this project is serving…</span>
        <div className="preview-bar">
          <Skeleton shape="text" width="40%" />
        </div>
        <Skeleton shape="block" className="preview-panel__skeleton" />
      </div>
    );
  }

  if (!ready) {
    return (
      <EmptyState
        icon={Browser}
        title="Nothing to preview yet"
        body={
          <>
            {state.reason ?? STOPPED_TEXT}
            <span className="preview-panel__ports">{WATCHED_PORTS}</span>
          </>
        }
        action={
          <Button
            size="sm"
            onClick={() => {
              actions.showPanel('console');
              actions.selectConsoleTab('output');
              actions.focusRun();
            }}
          >
            Go to console
          </Button>
        }
        className="preview-panel__empty"
      />
    );
  }

  const share = canShare ? () => actions.openShare('preview-link') : undefined;

  const tab = {
    href: tabUrl,
    mint: () => createPreviewGrant(projectId),
    onSpent: () => void preview.renewTab(),
    onOpened: opened,
  };

  return (
    <div className="preview-panel">
      <PreviewBar
        port={state.port as number}
        url={state.url as string}
        framable={framable}
        onReload={() => void open()}
        tab={tab}
        device={device}
        onDeviceChange={setDevice}
        onShare={share}
      />

      {!framable ? (
        <EmptyState
          icon={ArrowSquareOut}
          title="Your app is answering"
          body="This installation is served over plain HTTP, so the browser will not carry the preview into a frame. It opens in a new tab instead, signed in for you."
          action={<OpenInTabLink {...tab} fallbackHref={state.url as string} variant="primary" />}
          secondary={
            share ? (
              <Button variant="link" size="sm" icon={ShareNetwork} onClick={share}>
                Share this preview
              </Button>
            ) : undefined
          }
          className="preview-panel__empty"
        />
      ) : error ? (
        <div className="preview-panel__center">
          <Callout
            tone="danger"
            title={error}
            action={
              <Button size="sm" onClick={() => void open()}>
                Try again
              </Button>
            }
          />
        </div>
      ) : entryUrl ? (
        <Frame key={entryUrl} src={entryUrl} device={device} onLoaded={opened} onRetry={open} />
      ) : (
        <p className="preview-panel__opening" role="status">
          <Spinner size={12} aria-hidden="true" /> Opening the preview…
        </p>
      )}
    </div>
  );
}

/** The environment is not running, so neither is anything it could serve. */
function Stopped({
  status,
  available,
}: {
  status: string | undefined;
  available: boolean | undefined;
}): React.JSX.Element {
  const { focusStart } = useWorkspaceActions();
  const hintId = useId();

  if (available === false) {
    return (
      <EmptyState
        icon={Browser}
        title="Nothing to preview"
        body="This installation cannot start environments, so nothing can be served here."
        className="preview-panel__empty"
      />
    );
  }
  if (status && STARTING.has(status)) {
    return (
      <EmptyState
        icon={Browser}
        title="Nothing to preview"
        body="The environment is starting. Then run the app; the preview appears when it listens on a port."
        className="preview-panel__empty"
      />
    );
  }
  return (
    <EmptyState
      icon={Browser}
      title="Nothing to preview"
      body={STOPPED_TEXT}
      action={
        <>
          <Button variant="link" size="sm" onClick={focusStart} aria-describedby={hintId}>
            Show me
          </Button>
          <span id={hintId} className="visually-hidden">
            Flashes the Start button in the toolbar
          </span>
        </>
      }
      className="preview-panel__empty"
    />
  );
}

/** The framed page, with its loading and not-answering states. */
function Frame({
  src,
  device,
  onLoaded,
  onRetry,
}: {
  src: string;
  device: PreviewDevice;
  onLoaded: () => void;
  onRetry: () => Promise<void>;
}): React.JSX.Element {
  const [phase, setPhase] = useState<'loading' | 'loaded' | 'slow'>('loading');

  useEffect(() => {
    const timer = setTimeout(
      () => setPhase((current) => (current === 'loading' ? 'slow' : current)),
      SLOW_FRAME_MS,
    );
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={`preview-frame preview-frame--${device}`}>
      {phase === 'loading' ? (
        <Progress indeterminate label="Loading the preview" className="preview-frame__progress" />
      ) : null}
      {phase === 'slow' ? (
        <Callout
          tone="warn"
          title="The app is not answering yet."
          className="preview-frame__slow"
          action={
            <Button size="sm" onClick={() => void onRetry()}>
              Try again
            </Button>
          }
        >
          It may still be starting. If it stopped, the Output tab says why.
        </Callout>
      ) : null}
      <iframe
        className="preview-frame__page"
        title="Project preview"
        src={src}
        style={device === 'phone' ? { width: PHONE_PREVIEW_WIDTH } : undefined}
        onLoad={() => {
          setPhase('loaded');
          onLoaded();
        }}
        /*
         * Sandboxed, and deliberately not with allow-same-origin removed:
         * the preview is already on its own origin, and taking the origin
         * away as well would break every app that uses storage or a service
         * worker. What is withheld is the ability to reach out of the frame:
         * no top-level navigation, no downloads triggered at the platform's
         * expense.
         */
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}
