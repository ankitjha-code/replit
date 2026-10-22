import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LogLine, LogSource, LogStream } from '@platform/shared';
import { parseAnsi, stripAnsi } from '../lib/ansi.js';
import { ApiError } from '../lib/api-client.js';
import { formatDateTime } from '../lib/format.js';
import { fetchLogs, logExportUrl, type LogFilter } from '../lib/logs-api.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import { useVirtualRows } from '../lib/use-virtual-rows.js';
import { useProjectEvents } from '../workspace/use-project-events.js';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Input,
  SectionHeader,
  Select,
  Skeleton,
  Switch,
} from '../ui/index.js';
import { ArrowsClockwise, DownloadSimple, MagnifyingGlass, Scroll } from '../ui/icons.js';
import './observe/observe.css';

/** Every line is this tall, which is what lets twenty thousand of them scroll. */
const ROW_HEIGHT = 20;

/** The value of the source select that narrows to one runtime or deployment. */
const ONE_SOURCE = 'id:';

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** "GMT+5:30" where the engine can say so, the zone's abbreviation otherwise. */
function zoneLabel(): string {
  for (const timeZoneName of ['shortOffset', 'short'] as const) {
    try {
      const part = new Intl.DateTimeFormat(undefined, { timeZoneName })
        .formatToParts(new Date())
        .find((candidate) => candidate.type === 'timeZoneName');
      if (part) return part.value;
    } catch {
      // An older engine without shortOffset: fall through to the abbreviation.
    }
  }
  return 'local time';
}

const ZONE = zoneLabel();

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
  const [sourceChoice, setSourceChoice] = useState('');
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
  const [tailError, setTailError] = useState(false);

  const filter: LogFilter = {
    ...(sourceChoice.startsWith(ONE_SOURCE)
      ? { sourceId: sourceChoice.slice(ONE_SOURCE.length) }
      : sourceChoice
        ? { source: sourceChoice as LogSource }
        : {}),
    ...(stream ? { stream } : {}),
    ...(contains ? { contains } : {}),
  };
  const filtered = Object.keys(filter).length > 0;

  const resource = useResource(
    (signal) => fetchLogs(projectId, filter, signal),
    [projectId, sourceChoice, stream, contains],
  );
  const page = resource.data;

  const [lines, setLines] = useState<LogLine[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  /** Runtimes and deployments seen so far, so one can be picked out. */
  const [knownSources, setKnownSources] = useState<Map<string, LogSource>>(() => new Map());

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualRows({ count: lines.length, rowHeight: ROW_HEIGHT, scrollRef });
  const { scrollToEnd } = virtual;
  /** After the next render: jump to the end (a log is read from the end). */
  const stickToEnd = useRef(false);
  /** After the next render: how many rows were put in front, so the view stays put. */
  const prepended = useRef(0);

  useEffect(() => {
    if (!page) return;
    setLines(page.lines);
    setOlderCursor(page.olderCursor);
    stickToEnd.current = true;
  }, [page]);

  useEffect(() => {
    setKnownSources((known) => {
      let next: Map<string, LogSource> | undefined;
      for (const line of lines) {
        if (known.has(line.sourceId) || next?.has(line.sourceId)) continue;
        next ??= new Map(known);
        next.set(line.sourceId, line.source);
      }
      return next ?? known;
    });
  }, [lines]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (prepended.current > 0) {
      element.scrollTop += prepended.current * ROW_HEIGHT;
      prepended.current = 0;
    } else if (stickToEnd.current) {
      stickToEnd.current = false;
      scrollToEnd();
    }
  }, [lines, scrollToEnd]);

  /** Fetches the page before the oldest line on screen and puts it in front. */
  const older = useAction(async () => {
    if (!olderCursor) return;
    const fetched = await fetchLogs(projectId, { ...filter, before: olderCursor });
    prepended.current = fetched.lines.length;
    setLines((held) => [...fetched.lines, ...held]);
    setOlderCursor(fetched.olderCursor);
  });

  /*
   * The live tail.
   *
   * Told by the project's event socket that lines were written, it asks only for
   * what is newer than the last line on screen. One small read per burst of
   * output, rather than re-reading the page. It scrolls only while the reader
   * was already at the bottom.
   */
  const lastId = lines.at(-1)?.id;
  const atBottom = virtual.atBottom;
  useProjectEvents(projectId, (event) => {
    if (!following || event.type !== 'logs.appended') return;
    fetchLogs(projectId, { ...filter, ...(lastId ? { after: lastId } : {}) })
      .then((fetched) => {
        setTailError(false);
        if (fetched.lines.length === 0) return;
        stickToEnd.current = atBottom;
        setLines((held) => {
          const known = new Set(held.map((line) => line.id));
          return [...held, ...fetched.lines.filter((line) => !known.has(line.id))];
        });
      })
      .catch(() => setTailError(true));
  });

  const clearFilters = (): void => {
    setSourceChoice('');
    setStream('');
    setSearchText('');
    setContains('');
  };

  const initialLoading = page === undefined && resource.status === 'loading';
  const empty = page !== undefined && lines.length === 0;

  return (
    <section className="observe-section" aria-label="Logs">
      <SectionHeader
        title="Logs"
        icon={Scroll}
        description="What the app printed, kept after it stops. The console shows the app running now; this is the record of what has run."
      />

      <form
        className="logs-toolbar"
        role="search"
        aria-label="Filter output"
        onSubmit={(event) => {
          event.preventDefault();
          setContains(searchText.trim());
        }}
      >
        <Select
          aria-label="Where from"
          size="md"
          className="logs-toolbar__select"
          value={sourceChoice}
          onValueChange={setSourceChoice}
        >
          <option value="">Everything</option>
          <option value="RUN">The environment</option>
          <option value="DEPLOYMENT">Deployments</option>
          {knownSources.size > 0 ? (
            <optgroup label="One source">
              {[...knownSources].map(([id, source]) => (
                <option key={id} value={`${ONE_SOURCE}${id}`}>
                  {source === 'RUN' ? 'Environment' : 'Deployment'} {id.slice(0, 8)}
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
        <Select
          aria-label="Which stream"
          size="md"
          className="logs-toolbar__select"
          value={stream}
          onValueChange={(value) => setStream(value as LogStream | '')}
          options={[
            { value: '', label: 'Both streams' },
            { value: 'stdout', label: 'Standard output' },
            { value: 'stderr', label: 'Errors (stderr)' },
          ]}
        />
        <Input
          aria-label="Find in output"
          type="search"
          size="md"
          className="logs-toolbar__search"
          leading={<MagnifyingGlass size={14} aria-hidden="true" />}
          placeholder="Find text, then press Enter"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              setContains(searchText.trim());
            }
          }}
        />
        <Switch
          size="sm"
          className="logs-toolbar__follow"
          label="Follow"
          checked={following}
          onCheckedChange={setFollowing}
        />
        <span className="logs-toolbar__spacer" />
        <Button
          type="button"
          size="md"
          icon={ArrowsClockwise}
          loading={resource.status === 'refreshing'}
          loadingLabel="Refreshing"
          onClick={resource.reload}
        >
          Refresh
        </Button>
        {/* A link rather than a request: the server sends an attachment. */}
        <Button size="md" icon={DownloadSimple} asChild>
          <a href={logExportUrl(projectId, filter)}>Download</a>
        </Button>
      </form>

      {contains ? (
        <div className="logs-applied">
          <Badge tone="accent">Applied: &ldquo;{contains}&rdquo;</Badge>
          <Button
            size="sm"
            variant="link"
            onClick={() => {
              setContains('');
              setSearchText('');
            }}
          >
            Clear
          </Button>
        </div>
      ) : null}

      {resource.status === 'error' ? (
        <Callout
          tone="danger"
          title={
            resource.error instanceof ApiError
              ? resource.error.message
              : 'The log could not be loaded.'
          }
          action={
            <Button size="sm" onClick={resource.reload}>
              Retry
            </Button>
          }
        />
      ) : null}

      {tailError ? (
        <Callout
          tone="warn"
          title="New output could not be fetched. Refresh to catch up."
          onDismiss={() => setTailError(false)}
        />
      ) : null}

      {older.error ? (
        <Callout
          tone="danger"
          title={
            older.error instanceof ApiError
              ? older.error.message
              : 'Older output could not be loaded.'
          }
          action={
            <Button size="sm" onClick={() => void older.run()}>
              Retry
            </Button>
          }
        />
      ) : null}

      {initialLoading ? (
        <div className="logs-skeleton" aria-busy="true">
          <Skeleton height={12} width="70%" />
          <Skeleton height={12} width="55%" />
          <Skeleton height={12} width="80%" />
          <Skeleton height={12} width="40%" />
        </div>
      ) : null}

      {empty && !filtered ? (
        <EmptyState
          icon={Scroll}
          title="No output kept yet."
          body="Lines your app prints appear here and stay after it stops."
          action={
            <Button variant="primary" asChild>
              <Link to={`/projects/${encodeURIComponent(projectId)}`}>Open workspace</Link>
            </Button>
          }
        />
      ) : null}

      {empty && filtered ? (
        <EmptyState
          icon={MagnifyingGlass}
          title="Nothing matches these filters."
          body="Widen the source or stream, or search for something else."
          action={<Button onClick={clearFilters}>Clear filters</Button>}
        />
      ) : null}

      {page && lines.length > 0 ? (
        <p className="logs-meta">
          {olderCursor ? (
            <Button
              size="sm"
              variant="ghost"
              loading={older.busy}
              loadingLabel="Loading older output"
              onClick={() => void older.run()}
            >
              Load older
            </Button>
          ) : null}
          <span>
            {lines.length.toLocaleString()} {lines.length === 1 ? 'line' : 'lines'} shown
            {page.retainedLines > 0
              ? `, the most recent ${page.retainedLines.toLocaleString()} are kept`
              : ''}
          </span>
          <span>Times in {ZONE}</span>
          <span className="logs-legend">
            <span className="logs-legend__swatch" aria-hidden="true" />
            stderr
          </span>
        </p>
      ) : null}

      {/* Said when it is true, and not implied by an absence: reaching the end
          of what is on screen is not the same as reaching the beginning of what
          happened. */}
      {page?.truncated && !olderCursor ? (
        <p className="observe-note">
          This project is at the limit of what is kept, so older output has been dropped.
        </p>
      ) : null}

      {/* Always mounted so the virtual window can measure it; hidden until there
          is something to show. */}
      <div
        ref={scrollRef}
        className="logs-viewer"
        role="region"
        aria-label="Application output"
        aria-busy={resource.status === 'refreshing' || undefined}
        tabIndex={0}
        hidden={lines.length === 0}
      >
        <div
          style={{
            paddingTop: virtual.start * ROW_HEIGHT,
            paddingBottom: (lines.length - virtual.end) * ROW_HEIGHT,
          }}
        >
          {lines.slice(virtual.start, virtual.end).map((line) => (
            <LogRow key={line.id} line={line} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** One line: when, where from, and what, with the program's own colours. */
function LogRow({ line }: { line: LogLine }): React.JSX.Element {
  const spans = parseAnsi(line.message);
  return (
    <div
      className={`log-line${line.stream === 'stderr' ? ' log-line--stderr' : ''}`}
      title={`${formatDateTime(line.at)}\n${stripAnsi(line.message)}`}
    >
      <time className="log-line__time" dateTime={line.at}>
        {TIME.format(new Date(line.at))}
      </time>
      <span
        className="log-line__source"
        title={line.source === 'RUN' ? 'The environment' : 'A deployment'}
      >
        {line.source === 'RUN' ? 'ENV' : 'DEP'}
      </span>
      <span className="log-line__text">
        {spans.map((span, index) =>
          span.classes.length > 0 ? (
            <span key={index} className={span.classes.join(' ')}>
              {span.text}
            </span>
          ) : (
            span.text
          ),
        )}
      </span>
    </div>
  );
}
