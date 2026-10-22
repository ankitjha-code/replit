import { useMemo } from 'react';

export type ToastTone = 'success' | 'info' | 'warn' | 'danger';

export interface ToastOptions {
  tone?: ToastTone;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  /** Milliseconds before auto-dismiss. Danger toasts persist regardless. */
  duration?: number;
  /** Re-using an id replaces the toast with that id instead of adding one. */
  id?: string;
}

export interface ToastRecord {
  id: string;
  tone: ToastTone;
  title: string;
  description: string | undefined;
  action: { label: string; onClick: () => void } | undefined;
  duration: number;
  open: boolean;
}

export const TOAST_DURATION_MS = 5000;
/** How many toasts are on screen at once; the rest wait their turn. */
export const TOAST_LIMIT = 3;
/** Long enough for the exit transition (--duration-slow) before the record goes. */
const EXIT_MS = 300;

/*
 * The queue is module state rather than React context so that anything can
 * raise a toast: an API helper, a socket handler, a hook without a provider
 * above it. The Toaster viewport subscribes to it; without a viewport the
 * calls are harmless.
 */
let records: ToastRecord[] = [];
const listeners = new Set<() => void>();
let sequence = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function update(next: ToastRecord[]): void {
  records = next;
  emit();
}

export function toast(options: ToastOptions): string {
  const id = options.id ?? `toast-${++sequence}`;
  const tone = options.tone ?? 'info';
  const record: ToastRecord = {
    id,
    tone,
    title: options.title,
    description: options.description,
    action: options.action,
    duration: tone === 'danger' ? Infinity : (options.duration ?? TOAST_DURATION_MS),
    open: true,
  };
  const existing = records.findIndex((item) => item.id === id);
  if (existing >= 0) {
    update(records.map((item, index) => (index === existing ? record : item)));
  } else {
    update([...records, record]);
  }
  return id;
}

export function dismissToast(id: string): void {
  if (!records.some((item) => item.id === id && item.open)) return;
  update(records.map((item) => (item.id === id ? { ...item, open: false } : item)));
  setTimeout(() => {
    if (records.some((item) => item.id === id)) update(records.filter((item) => item.id !== id));
  }, EXIT_MS);
}

export function clearToasts(): void {
  update([]);
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): ToastRecord[] {
  return records;
}

export interface ToastApi {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

export function useToast(): ToastApi {
  return useMemo(() => ({ toast, dismiss: dismissToast }), []);
}
