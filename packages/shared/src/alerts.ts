import { z } from 'zod';

export const ALERT_KINDS = ['HEALTH', 'MEMORY'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_STATES = ['FIRING', 'RESOLVED'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const alertSettingsSchema = z.object({
  enabled: z.boolean(),
  failuresBeforeAlert: z.number().int().min(1).max(20),
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
  notified: z.boolean(),
  at: z.string(),
});

export type AlertEvent = z.infer<typeof alertEventSchema>;

export const alertResponseSchema = z.object({
  settings: alertSettingsSchema,
  firing: z.array(z.enum(ALERT_KINDS)),
  lastCheckedAt: z.string().nullable(),
  events: z.array(alertEventSchema),
  deliveryProblem: z.string().nullable(),
});

export type AlertResponse = z.infer<typeof alertResponseSchema>;
