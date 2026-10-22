import type { ProjectEvent } from '@platform/shared';
import type { Logger } from 'pino';

/**
 * What is happening in a project, in one place.
 *
 * A service that changes something publishes here; the socket gateway
 * subscribes. Neither knows about the other, which is the point: the file
 * service must not import a WebSocket, and a gateway must not be the only way
 * a change is noticed.
 *
 * In process, and deliberately. This is a single-host platform today, so the
 * simplest thing that is honest is a fan-out to the sockets this process is
 * holding. A second control plane would need a broker behind this interface,
 * and that is a substitution rather than a rewrite: nothing above depends on
 * where a listener lives.
 *
 * Nothing is retained. A subscriber is told what happens after it subscribes
 * and nothing about what happened before, because a client that has just
 * connected reloads what it needs over HTTP anyway. Keeping a backlog would be
 * inventing a second, weaker copy of state that already has an authority.
 */

export type ProjectEventListener = (event: ProjectEvent) => void;

export interface ProjectEventPublisher {
  publish(projectId: string, event: ProjectEvent): void;
}

export class ProjectEventBus implements ProjectEventPublisher {
  /** Listeners per project. A project with nobody watching holds no entry. */
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

  /**
   * Listeners that hear every project's events.
   *
   * One narrow use, and it is deliberately narrow: the socket gateways have to
   * react to somebody losing access to a project they are connected to, and
   * there is no project they could have subscribed to in advance to learn it.
   * Everything else subscribes per project.
   */
  private readonly global = new Set<(projectId: string, event: ProjectEvent) => void>();

  onAny(listener: (projectId: string, event: ProjectEvent) => void): () => void {
    this.global.add(listener);
    return () => this.global.delete(listener);
  }

  /**
   * Tells everyone watching this project.
   *
   * Never throws and never rejects. Publishing happens after the change it
   * describes has already been committed, so a listener that fails must not be
   * able to turn a successful write into a failed request. The failure is
   * logged and the remaining listeners are still told.
   */
  /**
   * Where events are sent so other control-plane processes hear them too.
   *
   * Absent on a single instance, which is the common case and needs nothing.
   * With several instances behind a load balancer, somebody connected to one
   * would otherwise never hear about a change made through another.
   */
  private relay?: { send(projectId: string, event: ProjectEvent): void };

  useRelay(relay: NonNullable<typeof this.relay>): void {
    this.relay = relay;
  }

  publish(projectId: string, event: ProjectEvent): void {
    this.deliverLocally(projectId, event);
    this.relay?.send(projectId, event);
  }

  /**
   * Hands an event to this process's listeners only.
   *
   * What a relay calls with an event from another process — never `publish`,
   * which would send it back out and have every instance echo every event for
   * ever.
   */
  deliverLocally(projectId: string, event: ProjectEvent): void {
    // A copy in both cases, because a listener may unsubscribe itself while
    // being called and mutating the set underneath the iteration would skip its
    // neighbour.
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

  /** How many projects currently have somebody watching. Diagnostics only. */
  get watchedProjects(): number {
    return this.listeners.size;
  }
}
