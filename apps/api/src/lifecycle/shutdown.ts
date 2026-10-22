import type { Logger } from 'pino';

/**
 * Orderly shutdown of the control plane.
 *
 * Ordering matters and is the reason this is a separate, tested unit rather
 * than a closure inside the entrypoint: the HTTP server must stop accepting
 * and finish in-flight requests *before* the database pool closes, or a
 * request still running loses its connection mid-query.
 *
 * A hung dependency must not be able to prevent exit, so a timer forces the
 * process down regardless.
 */
export interface ShutdownTargets {
  /**
   * Closes long-lived connections, before the HTTP server stops.
   *
   * A WebSocket carrying a terminal never finishes on its own, so waiting for
   * in-flight work to end would wait for ever. Told first, each one can say
   * goodbye rather than having the socket cut from under it.
   */
  closeConnections?: (() => Promise<void>) | undefined;
  /** Stops accepting connections and resolves once in-flight work finishes. */
  closeServer: () => Promise<void>;
  /** Releases pooled connections. Absent when no database is configured. */
  disconnectDatabase?: (() => Promise<void>) | undefined;
  log: Logger;
  /** Hard ceiling on the whole sequence. */
  forceExitAfterMs?: number;
  exit: (code: number) => void;
}

export type ShutdownHandler = (signal: string) => void;

export function createShutdownHandler(targets: ShutdownTargets): ShutdownHandler {
  const {
    closeConnections,
    closeServer,
    disconnectDatabase,
    log,
    exit,
    forceExitAfterMs = 15_000,
  } = targets;

  let running = false;

  return (signal: string): void => {
    // Repeated signals during shutdown are ignored. A second Ctrl+C should not
    // start a second teardown over a half-torn-down process.
    if (running) return;
    running = true;

    log.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      log.error({ timeoutMs: forceExitAfterMs }, 'graceful shutdown timed out; forcing exit');
      exit(1);
    }, forceExitAfterMs);
    force.unref?.();

    void (async () => {
      let code = 0;

      if (closeConnections) {
        try {
          await closeConnections();
        } catch (error) {
          log.error({ err: error }, 'error while closing long-lived connections');
          code = 1;
        }
      }

      try {
        await closeServer();
      } catch (error) {
        log.error({ err: error }, 'error while closing http server');
        code = 1;
      }

      // Attempted even if the server failed to close cleanly: leaving
      // connections open is worse than the error already reported.
      if (disconnectDatabase) {
        try {
          await disconnectDatabase();
        } catch (error) {
          log.error({ err: error }, 'error while closing database');
          code = 1;
        }
      }

      clearTimeout(force);
      log.info({ code }, 'shutdown complete');
      exit(code);
    })();
  };
}
