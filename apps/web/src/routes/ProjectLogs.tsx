import { useCallback, useEffect, useState } from 'react';
import { LOG_SOURCES, type LogLine, type LogSource, type LogStream } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fetchLogs, logExportUrl } from '../lib/logs-api.js';
import { useProjectEvents } from '../workspace/use-project-events.js';

/**
 * What this project's applications printed.
 *
 * Not the console. The console is a live socket onto a program that is running
 * now, and it is gone when the control plane restarts. This is the written-down
 * copy, and it answers the questions the console cannot: what did it print
 * before it crashed, what was the deployment doing overnight, did it ever start.
 *
 * Read from the end, like every log. Older pages are asked for explicitly rather
 * than loaded on scroll, because a project that printed a hundred thousand lines
 * should not be able to make this page fetch them by accident.
 */
export function ProjectLogs({ projectId }: { projectId: string }): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [retained, setRetained] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const [source, setSource] = useState<LogSource | ''>('');
  const [stream, setStream] = useState<LogStream | ''>('');
  /** What the search box says, and what has actually been searched for. */
  const [searchText, setSearchText] = useState('');
  const [contains, setContains] = useState('');
  /**
   * Whether new output appears as it is written.
   *
   * Off by default: a log somebody is reading should not scroll under them. On,
   * the page is told new lines exist and fetches only those.
   */
  const [following, setFollowing] = useState(false);

  const filter = {
    ...(source ? { source } : {}),
    ...(stream ? { stream } : {}),
    ...(contains ? { contains } : {}),
  };

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const fetched = await fetchLogs(
          projectId,
          {
            ...(source ? { source } : {}),
            ...(stream ? { stream } : {}),
            ...(contains ? { contains } : {}),
          },
          signal,
        );

        if (signal?.aborted) return;
        setLines(fetched.lines);
        setOlderCursor(fetched.olderCursor);
        setRetained(fetched.retainedLines);
        setTruncated(fetched.truncated);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The log could not be loaded.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId, source, stream, contains],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /*
   * The live tail.
   *
   * Told by the project's event socket that lines were written, it asks only for
   * what is newer than the last line on screen. One small read per burst of
   * output, rather than re-reading the page.
   */
  const lastId = lines.at(-1)?.id;
  useProjectEvents(projectId, (event) => {
    if (!following || event.type !== 'logs.appended') return;

    fetchLogs(projectId, { ...filter, ...(lastId ? { after: lastId } : {}) })
      .then((fetched) => {
        if (fetched.lines.length === 0) return;
        setLines((held) => {
          const known = new Set(held.map((line) => line.id));
          return [...held, ...fetched.lines.filter((line) => !known.has(line.id))];
        });
      })
      .catch(() => undefined);
  });

  /** Fetches the page before the oldest line on screen and puts it in front. */
  const older = async (): Promise<void> => {
    if (!olderCursor) return;

    setBusy(true);
    setError(undefined);

    try {
      const fetched = await fetchLogs(projectId, {
        ...(source ? { source } : {}),
        ...(stream ? { stream } : {}),
        before: olderCursor,
      });

      setLines((held) => [...fetched.lines, ...held]);
      setOlderCursor(fetched.olderCursor);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Older output could not be loaded.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-section" aria-labelledby="logs-heading">
      <h2 id="logs-heading">Output</h2>
      <p className="project-section__hint">
        What this project&apos;s applications printed, kept after they stopped. The console in the
        workspace shows a program that is running now; this is the record of what has run.
        {retained > 0 && ` The most recent ${retained.toLocaleString()} lines are kept.`}
      </p>

      <div className="project-section__form">
        <label htmlFor="log-source">Where from</label>
        <select
          id="log-source"
          value={source}
          onChange={(event) => setSource(event.target.value as LogSource | '')}
        >
          <option value="">Everything</option>
          {LOG_SOURCES.map((value) => (
            <option key={value} value={value}>
              {sourceLabel(value)}
            </option>
          ))}
        </select>

        <label htmlFor="log-stream">Which stream</label>
        <select
          id="log-stream"
          value={stream}
          onChange={(event) => setStream(event.target.value as LogStream | '')}
        >
          <option value="">Both</option>
          <option value="stdout">Standard output</option>
          <option value="stderr">Errors</option>
        </select>

        <label htmlFor="log-search">Containing</label>
        <input
          id="log-search"
          className="input"
          value={searchText}
          placeholder="text to find"
          onChange={(event) => setSearchText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setContains(searchText.trim());
          }}
        />
        <button
          type="button"
          className="button-quiet"
          onClick={() => setContains(searchText.trim())}
        >
          Search
        </button>

        <button type="button" className="button-quiet" disabled={busy} onClick={() => void load()}>
          Refresh
        </button>

        <label className="account__check">
          <input
            type="checkbox"
            checked={following}
            onChange={(event) => setFollowing(event.target.checked)}
          />
          <span>Follow new output</span>
        </label>

        {/* A link rather than a request: the server sends an attachment. */}
        <a className="button-quiet" href={logExportUrl(projectId, filter)}>
          Download
        </a>
      </div>

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="project-section__note">Loading the log…</p>}

      {!loading && lines.length === 0 && (
        <p className="project-section__note">Nothing has been printed yet.</p>
      )}

      {olderCursor && (
        <button type="button" className="icon-button" disabled={busy} onClick={() => void older()}>
          {busy ? 'Loading…' : 'Load older output'}
        </button>
      )}

      {/* Said when it is true, and not implied by an absence: reaching the end
          of what is on screen is not the same as reaching the beginning of what
          happened. */}
      {truncated && !olderCursor && (
        <p className="project-section__note">
          This project is at the limit of what is kept, so older output has been dropped.
        </p>
      )}

      {lines.length > 0 && (
        <pre className="build-log" aria-label="Application output">
          {lines.map((line) => (
            <span
              key={line.id}
              className={line.stream === 'stderr' ? 'log-line log-line--error' : 'log-line'}
            >
              {`${new Date(line.at).toLocaleTimeString()}  ${line.message}\n`}
            </span>
          ))}
        </pre>
      )}
    </section>
  );
}

/** Where a line came from, in the words the page uses. */
function sourceLabel(source: LogSource): string {
  switch (source) {
    case 'RUN':
      return 'The workspace';
    case 'DEPLOYMENT':
      return 'A deployment';
  }
}
