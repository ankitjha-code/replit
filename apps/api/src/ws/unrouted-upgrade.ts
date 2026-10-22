import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  projectIdFromDocumentPath,
  projectIdFromEventsPath,
  projectIdFromOutputPath,
  projectIdFromTerminalPath,
} from '@platform/shared';

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
