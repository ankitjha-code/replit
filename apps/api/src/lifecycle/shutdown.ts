import type { Logger } from 'pino';

export interface ShutdownTargets {
  closeConnections?: (() => Promise<void>) | undefined;
  closeServer: () => Promise<void>;
  disconnectDatabase?: (() => Promise<void>) | undefined;
  log: Logger;
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
