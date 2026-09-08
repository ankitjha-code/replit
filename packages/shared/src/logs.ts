import { z } from 'zod';

/**
 * What a project's applications printed, kept.
 *
 * Until now output lived in memory: a ring buffer per runtime, read by whoever
 * had the console open and gone the moment the control plane restarted. That is
 * the right shape for watching something run and the wrong one for every
 * question asked afterwards — what did it print before it crashed, what was it
 * doing at four in the morning, did the deployment ever start.
 *
 * So output is also written down. The in-memory buffer stays, because a console
 * that had to poll a table would be a worse console; this is the durable record
 * beside it, and the two are fed from the same stream.
 *
 * Deliberately bounded and deliberately not a log aggregator. A project keeps a
 * fixed number of recent lines and the oldest are dropped. A platform that
 * promised to keep everything would be promising something it cannot pay for,
 * and saying "these are the last N lines" is a promise it can keep.
 */

/** Where a line came from. */
export const LOG_SOURCES = [
  /** The project's own application, running in its development runtime. */
  'RUN',
  /** A deployment, running unattended. */
  'DEPLOYMENT',
] as const;

export type LogSource = (typeof LOG_SOURCES)[number];

export const LOG_STREAMS = ['stdout', 'stderr'] as const;

export type LogStream = (typeof LOG_STREAMS)[number];

/**
 * The longest single line kept.
 *
 * A program can print a megabyte without a newline, and a column has to end
 * somewhere. What is dropped is the end of an absurd line rather than the line
 * itself, so something still appears where it happened.
 */
export const MAX_LOG_LINE_LENGTH = 2_000;

export const logLineSchema = z.object({
  id: z.string(),
  source: z.enum(LOG_SOURCES),
  /**
   * What produced it: a runtime id, or a deployment id.
   *
   * Kept so one deployment's output can be read apart from its predecessor's,
   * which is the question somebody asks immediately after a bad release.
   */
  sourceId: z.string(),
  stream: z.enum(LOG_STREAMS),
  message: z.string(),
  at: z.string(),
});

export type LogLine = z.infer<typeof logLineSchema>;

/**
 * How much of a log is asked for at once.
 *
 * Bounded because the answer is rendered, and a page that asks for everything
 * would be a page that hangs on the projects that need it most.
 */
export const MAX_LOG_PAGE = 500;
export const DEFAULT_LOG_PAGE = 200;

export const logQuerySchema = z.object({
  source: z.enum(LOG_SOURCES).optional(),
  /** Narrows to one runtime or one deployment. */
  sourceId: z.string().max(64).optional(),
  /** Only errors, which is what somebody looking for a problem wants. */
  stream: z.enum(LOG_STREAMS).optional(),
  /**
   * Paging, backwards.
   *
   * A log is read from the end, so paging means "older than this one". An
   * offset would re-number every page as new lines arrived.
   */
  before: z.string().max(64).optional(),
  /**
   * Only lines newer than this one, oldest first — the live tail.
   *
   * The counterpart of `before`, used after the page is told new lines exist:
   * it fetches exactly what arrived since the last line it has, so a tail costs
   * one small read per burst of output rather than a re-read of the page.
   */
  after: z.string().max(64).optional(),
  /**
   * Only lines containing this text, ignoring case.
   *
   * A substring rather than a pattern: a regular expression typed into a box is
   * a way to make the database do unbounded work, and "find the line with the
   * error in it" does not need one.
   */
  contains: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LOG_PAGE).optional(),
});

export type LogQuery = z.infer<typeof logQuerySchema>;

export const logResponseSchema = z.object({
  /** Oldest first, which is the order a log is read in. */
  lines: z.array(logLineSchema),
  /**
   * The cursor for the page before this one, or null at the beginning.
   *
   * Null means there is nothing older **that the platform still has**, which is
   * not the same as nothing older having happened. The retention note below
   * says which.
   */
  olderCursor: z.string().nullable(),
  /** How many lines a project keeps before the oldest are dropped. */
  retainedLines: z.number().int().positive(),
  /** True when the ceiling has been reached, so older output has been dropped. */
  truncated: z.boolean(),
});

export type LogResponse = z.infer<typeof logResponseSchema>;
