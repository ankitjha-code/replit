import {
  runStateSchema,
  runtimeStateResponseSchema,
  terminalSessionsResponseSchema,
  workspaceSyncResultSchema,
  type TerminalSessionSummary,
  type RuntimeLanguage,
  type RunState,
  type RuntimeStateResponse,
  type WorkspaceSyncResult,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

/**
 * Runtime calls.
 *
 * Start and stop return the same shape as reading the state, so a caller never
 * has to guess what happened: it renders whatever came back.
 */

const base = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/runtime`;

export async function fetchRuntimeState(
  projectId: string,
  signal?: AbortSignal,
): Promise<RuntimeStateResponse> {
  const payload = await apiRequest<unknown>(base(projectId), signal ? { signal } : {});
  return runtimeStateResponseSchema.parse(payload);
}

export async function startRuntime(
  projectId: string,
  language?: RuntimeLanguage,
): Promise<RuntimeStateResponse> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/start`, {
    method: 'POST',
    body: language ? { language } : {},
  });
  return runtimeStateResponseSchema.parse(payload);
}

export async function stopRuntime(projectId: string): Promise<RuntimeStateResponse> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/stop`, {
    method: 'POST',
    body: {},
  });
  return runtimeStateResponseSchema.parse(payload);
}

/**
 * Reads the runtime's files back into the project.
 *
 * Not something the platform can do quietly in the background: it replaces
 * files the person may have open, so it is an action they take.
 */
export async function syncRuntimeFiles(projectId: string): Promise<WorkspaceSyncResult> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/sync`, {
    method: 'POST',
    body: {},
  });
  return workspaceSyncResultSchema.parse(payload);
}

/**
 * The project's own application, which is not the runtime.
 *
 * A runtime is the container; this is the program inside it. Two calls rather
 * than one because they can disagree, and a person needs to see when they do:
 * a crashed application inside a healthy container is a state with its own
 * answer.
 */
export async function fetchRunState(projectId: string, signal?: AbortSignal): Promise<RunState> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/run`, signal ? { signal } : {});
  return runStateSchema.parse(payload);
}

export async function startRun(projectId: string): Promise<RunState> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/run/start`, {
    method: 'POST',
    body: {},
  });
  return runStateSchema.parse(payload);
}

export async function stopRun(projectId: string): Promise<RunState> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/run/stop`, {
    method: 'POST',
    body: {},
  });
  return runStateSchema.parse(payload);
}

/** Null clears it, which puts the project back on the platform's suggestion. */
export async function setRunCommand(projectId: string, command: string | null): Promise<RunState> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/run/command`, {
    method: 'PUT',
    body: { command },
  });
  return runStateSchema.parse(payload);
}

/**
 * The shells this person has open in this project.
 *
 * Asked for rather than remembered. A browser that reloaded has forgotten
 * which session it had, and one that kept a note of it may be holding an
 * identifier for a shell that has since been closed or reaped. The server is
 * the only thing that knows, so it is the thing that is asked.
 */
export async function fetchTerminalSessions(
  projectId: string,
  signal?: AbortSignal,
): Promise<TerminalSessionSummary[]> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/terminals`,
    signal ? { signal } : {},
  );
  return terminalSessionsResponseSchema.parse(payload).sessions;
}

/** Ends one shell. What a person means by closing a terminal rather than a tab. */
export async function closeTerminalSession(projectId: string, sessionId: string): Promise<void> {
  await apiRequest<unknown>(`${base(projectId)}/terminals/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}
