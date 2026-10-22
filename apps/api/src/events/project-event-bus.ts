import type { ProjectEvent } from '@platform/shared';
import type { Logger } from 'pino';

export type ProjectEventListener = (event: ProjectEvent) => void;

export interface ProjectEventPublisher {
  publish(projectId: string, event: ProjectEvent): void;
}

export class ProjectEventBus implements ProjectEventPublisher {
  private readonly listeners = new Map<string, Set<ProjectEventListener>>();

  constructor(private readonly log: Logger) {}

  subscribe(projectId: string, listener: ProjectEventListener): () => void {
    const group = this.listeners.get(projectId) ?? new Set<ProjectEventListener>();
    group.add(listener);
    this.listeners.set(projectId, group);

    return () => {
      const current = this.listeners.get(projectId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(projectId);
    };
  }

  private readonly global = new Set<(projectId: string, event: ProjectEvent) => void>();

  onAny(listener: (projectId: string, event: ProjectEvent) => void): () => void {
    this.global.add(listener);
    return () => this.global.delete(listener);
  }

  private relay?: { send(projectId: string, event: ProjectEvent): void };

  useRelay(relay: NonNullable<typeof this.relay>): void {
    this.relay = relay;
  }

  publish(projectId: string, event: ProjectEvent): void {
    this.deliverLocally(projectId, event);
    this.relay?.send(projectId, event);
  }

  deliverLocally(projectId: string, event: ProjectEvent): void {
    for (const listener of [...this.global]) {
      try {
        listener(projectId, event);
      } catch (error) {
        this.log.error(
          { err: error, projectId, type: event.type },
          'a global event listener threw',
        );
      }
    }

    const group = this.listeners.get(projectId);
    if (!group) return;

    for (const listener of [...group]) {
      try {
        listener(event);
      } catch (error) {
        this.log.error(
          { err: error, projectId, type: event.type },
          'a project event listener threw',
        );
      }
    }
  }

  get watchedProjects(): number {
    return this.listeners.size;
  }
}
