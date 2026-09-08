import { z } from 'zod';

/**
 * Telling somebody when their deployment stops answering.
 *
 * Opt-in, per project, and about deployments only. A workspace environment
 * that is stopped is a person who closed their laptop; a deployment that stops
 * answering is somebody else's page that no longer loads, and only the second
 * is worth an email.
 *
 * Two conditions, both the ones the monitoring page already measures:
 *
 *  - **Health**: the application failed its health check this many times in a
 *    row. More than once by default, because a single failed request is a
 *    restart or a slow garbage collection, and an alert that fires on those is
 *    one people learn to ignore.
 *  - **Memory**: it is using this share of the memory it is allowed. Memory
 *    rather than processor, because running out of memory is what kills a
 *    container, whereas a busy processor only slows it down.
 *
 * One email when an alert starts and one when it clears. Never one per check:
 * an outage overnight should be two messages in the morning, not five hundred.
 */

export const ALERT_KINDS = ['HEALTH', 'MEMORY'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_STATES = ['FIRING', 'RESOLVED'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const alertSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Consecutive failed health checks before an alert starts. */
  failuresBeforeAlert: z.number().int().min(1).max(20),
  /** Null leaves memory unwatched. At least half, because below that it is not a warning. */
  memoryPercent: z.number().int().min(50).max(100).nullable(),
});

export type AlertSettings = z.infer<typeof alertSettingsSchema>;

export const updateAlertSettingsRequestSchema = alertSettingsSchema;
export type UpdateAlertSettingsRequest = AlertSettings;

export const alertEventSchema = z.object({
  id: z.string(),
  kind: z.enum(ALERT_KINDS),
  state: z.enum(ALERT_STATES),
  message: z.string(),
  /** Whether an email actually went. False is shown, never hidden. */
  notified: z.boolean(),
  at: z.string(),
});

export type AlertEvent = z.infer<typeof alertEventSchema>;

export const alertResponseSchema = z.object({
  settings: alertSettingsSchema,
  /** What is wrong right now. */
  firing: z.array(z.enum(ALERT_KINDS)),
  /** When the last check was made, or null if none has been. */
  lastCheckedAt: z.string().nullable(),
  /** Most recent first. */
  events: z.array(alertEventSchema),
  /**
   * Why an alert would not reach anybody, or null when it would: no mail server,
   * or an owner whose address was never confirmed. Said up front, because an
   * alert that silently goes nowhere is worse than no alert.
   */
  deliveryProblem: z.string().nullable(),
});

export type AlertResponse = z.infer<typeof alertResponseSchema>;
