import { z } from 'zod';

/**
 * Reaching a port a project is listening on.
 *
 * The rule this whole area exists to satisfy: a person can see their
 * application without the container ever being reachable from the network. The
 * platform is the only thing that talks to a workload, and it forwards.
 *
 * The second rule, less obvious and more important: a project's own pages are
 * never served from the platform's origin. Whatever a project serves is code
 * the platform did not write, and on the platform's origin it would be able to
 * act as the person viewing it.
 */

/**
 * Ports the platform will look for an application on.
 *
 * A fixed list rather than a scan. These are the defaults of the frameworks in
 * the runtime catalogue, and publishing a bounded set is what lets the platform
 * find an application without opening a container to anything else.
 */
export const PREVIEW_CANDIDATE_PORTS = [3000, 5000, 5173, 8000, 8080, 80] as const;

export type PreviewCandidatePort = (typeof PREVIEW_CANDIDATE_PORTS)[number];

export function isPreviewCandidatePort(port: number): port is PreviewCandidatePort {
  return (PREVIEW_CANDIDATE_PORTS as readonly number[]).includes(port);
}

/**
 * The hostname a project's preview is served on.
 *
 * One host per project, so two projects are two origins and neither can script
 * the other. The suffix carries the port when there is one, because a hostname
 * with a port is what a browser needs and splitting them apart here only means
 * putting them back together at every call site.
 */
export function previewHost(projectId: string, suffix: string): string {
  return `${projectId}.${suffix}`;
}

/** Reads a project identifier back out of a preview hostname. */
export function projectIdFromPreviewHost(host: string, suffix: string): string | undefined {
  // The port is part of the Host header, and part of the configured suffix.
  const expected = `.${suffix.toLowerCase()}`;
  const lower = host.toLowerCase();
  if (!lower.endsWith(expected)) return undefined;

  const label = lower.slice(0, -expected.length);
  // One label. Anything with a dot in it is a deeper name that this route does
  // not serve, and treating it as a project would accept names it should not.
  if (label.length === 0 || label.includes('.')) return undefined;
  return label;
}

/** Where the grant token is presented, and what it is called there. */
export const PREVIEW_GRANT_PATH = '/__preview-grant';
export const PREVIEW_GRANT_PARAM = 't';

/**
 * The query parameter a share link carries.
 *
 * Distinct from the one-time grant's, because the two are redeemed differently:
 * a grant belongs to a signed-in member and is spent at once, a share belongs
 * to whoever was sent the link and works until it expires or is revoked.
 */
export const PREVIEW_SHARE_PARAM = 'share';

export const createPreviewShareRequestSchema = z.object({
  /** How long it works for. A week at most: longer is what deploying is for. */
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
  /** Null while it still works. */
  revokedAt: z.string().nullable(),
});

export type PreviewShare = z.infer<typeof previewShareSchema>;

export const previewStateSchema = z.object({
  /** Null when nothing is running, or nothing is listening yet. */
  url: z.string().nullable(),
  /** The container port an application was found on. */
  port: z.number().int().positive().nullable(),
  /**
   * Why there is nothing to show, in words a person can act on. Null when
   * there is something.
   */
  reason: z.string().nullable(),
  /** The ports the platform looked at, so "nothing found" can be explained. */
  candidatePorts: z.array(z.number().int().positive()),
  /**
   * Whether the workspace can show the preview inside itself.
   *
   * A preview is on its own site, so the cookie that carries permission is a
   * third-party cookie when the page is in a frame. Browsers only send one of
   * those when it is marked `SameSite=None; Secure`, and a browser only
   * accepts `Secure` over HTTPS. So an installation served over plain HTTP can
   * open a preview in a tab but not in a frame, and the workspace is told
   * which rather than left to discover it by showing an error.
   */
  framable: z.boolean(),
});

export type PreviewState = z.infer<typeof previewStateSchema>;

export const previewShareListResponseSchema = z.object({ shares: z.array(previewShareSchema) });

/** The only response that carries the address; the server keeps just its hash. */
export const createPreviewShareResponseSchema = z.object({
  share: previewShareSchema,
  url: z.string(),
});
