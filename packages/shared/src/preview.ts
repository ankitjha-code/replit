import { z } from 'zod';

export const PREVIEW_CANDIDATE_PORTS = [3000, 5000, 5173, 8000, 8080, 80] as const;

export type PreviewCandidatePort = (typeof PREVIEW_CANDIDATE_PORTS)[number];

export function isPreviewCandidatePort(port: number): port is PreviewCandidatePort {
  return (PREVIEW_CANDIDATE_PORTS as readonly number[]).includes(port);
}

export function previewHost(projectId: string, suffix: string): string {
  return `${projectId}.${suffix}`;
}

export function projectIdFromPreviewHost(host: string, suffix: string): string | undefined {
  const expected = `.${suffix.toLowerCase()}`;
  const lower = host.toLowerCase();
  if (!lower.endsWith(expected)) return undefined;

  const label = lower.slice(0, -expected.length);
  if (label.length === 0 || label.includes('.')) return undefined;
  return label;
}

export const PREVIEW_GRANT_PATH = '/__preview-grant';
export const PREVIEW_GRANT_PARAM = 't';

export const PREVIEW_SHARE_PARAM = 'share';

export const createPreviewShareRequestSchema = z.object({
  hours: z.number().int().min(1).max(168),
  label: z.string().trim().max(100).optional(),
});

export type CreatePreviewShareRequest = z.infer<typeof createPreviewShareRequestSchema>;

export const previewShareSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});

export type PreviewShare = z.infer<typeof previewShareSchema>;

export const previewStateSchema = z.object({
  url: z.string().nullable(),
  port: z.number().int().positive().nullable(),
  reason: z.string().nullable(),
  candidatePorts: z.array(z.number().int().positive()),
  framable: z.boolean(),
});

export type PreviewState = z.infer<typeof previewStateSchema>;

export const previewShareListResponseSchema = z.object({ shares: z.array(previewShareSchema) });

export const createPreviewShareResponseSchema = z.object({
  share: previewShareSchema,
  url: z.string(),
});
