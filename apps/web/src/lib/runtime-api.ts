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

export async function syncRuntimeFiles(projectId: string): Promise<WorkspaceSyncResult> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/sync`, {
    method: 'POST',
    body: {},
  });
  return workspaceSyncResultSchema.parse(payload);
}

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

export async function setRunCommand(projectId: string, command: string | null): Promise<RunState> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/run/command`, {
    method: 'PUT',
    body: { command },
  });
  return runStateSchema.parse(payload);
}

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

export async function closeTerminalSession(projectId: string, sessionId: string): Promise<void> {
  await apiRequest<unknown>(`${base(projectId)}/terminals/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}
