import { z } from 'zod';

export const LOG_SOURCES = ['RUN', 'DEPLOYMENT'] as const;

export type LogSource = (typeof LOG_SOURCES)[number];

export const LOG_STREAMS = ['stdout', 'stderr'] as const;

export type LogStream = (typeof LOG_STREAMS)[number];

export const MAX_LOG_LINE_LENGTH = 2_000;

export const logLineSchema = z.object({
  id: z.string(),
  source: z.enum(LOG_SOURCES),
  sourceId: z.string(),
  stream: z.enum(LOG_STREAMS),
  message: z.string(),
  at: z.string(),
});

export type LogLine = z.infer<typeof logLineSchema>;

export const MAX_LOG_PAGE = 500;
export const DEFAULT_LOG_PAGE = 200;

export const logQuerySchema = z.object({
  source: z.enum(LOG_SOURCES).optional(),
  sourceId: z.string().max(64).optional(),
  stream: z.enum(LOG_STREAMS).optional(),
  before: z.string().max(64).optional(),
  after: z.string().max(64).optional(),
  contains: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LOG_PAGE).optional(),
});

export type LogQuery = z.infer<typeof logQuerySchema>;

export const logResponseSchema = z.object({
  lines: z.array(logLineSchema),
  olderCursor: z.string().nullable(),
  retainedLines: z.number().int().positive(),
  truncated: z.boolean(),
});

export type LogResponse = z.infer<typeof logResponseSchema>;
