import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  projectIdFromDocumentPath,
  projectIdFromEventsPath,
  projectIdFromOutputPath,
  projectIdFromTerminalPath,
} from '@platform/shared';

/**
 * Refuses a WebSocket upgrade no gateway serves.
 *
 * Each gateway listens to the same upgrade event and takes only its own route,
 * so something has to answer the rest, or an unknown path leaves a client
 * waiting on a socket nobody will ever accept. That answer used to come from the
 * terminal gateway, by accident: it treated every route but one as its own,
 * which also meant it refused the events and document sockets before their own
 * gateways could accept them. Kept here, once, with the list of routes that
 * are served next to it.
 */
const SERVED = [
  projectIdFromTerminalPath,
  projectIdFromOutputPath,
  projectIdFromEventsPath,
  projectIdFromDocumentPath,
];

export function isServedUpgradePath(url: string | undefined): boolean {
  if (!url) return false;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://placeholder.invalid').pathname;
  } catch {
    return false;
  }
  return SERVED.some((match) => match(pathname) !== undefined);
}

export function refuseUnroutedUpgrades(server: Server): void {
  server.on('upgrade', (req: { url?: string }, socket: Duplex) => {
    if (isServedUpgradePath(req.url)) return;
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
}
