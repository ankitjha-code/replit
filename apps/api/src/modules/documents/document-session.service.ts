import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { DOCUMENT_AWARENESS, participantColour, type DocumentParticipant } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { FileService } from '../files/file.service.js';

export interface DocumentSessionOptions {
  maxPerProject: number;
  saveDebounceMs: number;
  saveCeilingMs: number;
}

export interface DocumentClient {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly canWrite: boolean;
  send(frame: Uint8Array): void;
  notify(message: DocumentNotice): void;
}

export type DocumentNotice =
  | { type: 'participants'; participants: DocumentParticipant[] }
  | { type: 'saved'; at: string; version: number }
  | { type: 'stale'; message: string };

export class DocumentSession {
  readonly doc = new Y.Doc();
  readonly clients = new Set<DocumentClient>();

  readonly awareness = new Awareness(this.doc);

  readonly awarenessOwners = new Map<number, DocumentClient>();

  version: number;

  stale = false;

  dirty = false;

  debounce: ReturnType<typeof setTimeout> | undefined;
  ceiling: ReturnType<typeof setTimeout> | undefined;

  writing: Promise<void> = Promise.resolve();

  constructor(
    readonly projectId: string,
    readonly path: string,
    version: number,
  ) {
    this.version = version;
  }

  get text(): Y.Text {
    return this.doc.getText('content');
  }

  acceptAwareness(client: DocumentClient, update: Uint8Array): Uint8Array | undefined {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const touched: number[] = [];
    for (let index = 0; index < count; index += 1) {
      touched.push(decoding.readVarUint(decoder));
      decoding.readVarUint(decoder);
      decoding.readVarString(decoder);
    }

    for (const id of touched) {
      const owner = this.awarenessOwners.get(id);
      if (owner && owner !== client) return undefined;
    }
    for (const id of touched) this.awarenessOwners.set(id, client);

    applyAwarenessUpdate(this.awareness, update, client);

    for (const id of touched) {
      const state = this.awareness.getStates().get(id);
      if (!state) continue;
      state.user = {
        name: client.displayName || client.username,
        colour: participantColour(client.userId),
      };
    }

    return encodeAwarenessUpdate(this.awareness, touched);
  }

  awarenessSnapshot(): Uint8Array | undefined {
    const ids = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    return ids.length > 0 ? encodeAwarenessUpdate(this.awareness, ids) : undefined;
  }

  forgetAwareness(client: DocumentClient): Uint8Array | undefined {
    const ids = [...this.awarenessOwners.entries()]
      .filter(([, owner]) => owner === client)
      .map(([id]) => id);
    if (ids.length === 0) return undefined;

    for (const id of ids) this.awarenessOwners.delete(id);
    removeAwarenessStates(this.awareness, ids, 'left');
    return encodeAwarenessUpdate(this.awareness, ids);
  }

  participants(): DocumentParticipant[] {
    const byUser = new Map<string, DocumentParticipant>();

    for (const client of this.clients) {
      const held = byUser.get(client.userId);
      if (held) {
        held.canWrite = held.canWrite || client.canWrite;
        continue;
      }
      byUser.set(client.userId, {
        userId: client.userId,
        username: client.username,
        displayName: client.displayName,
        canWrite: client.canWrite,
      });
    }

    return [...byUser.values()].sort((a, b) => a.username.localeCompare(b.username));
  }
}

export class DocumentSessionService {
  private readonly sessions = new Map<string, DocumentSession>();

  constructor(
    private readonly files: FileService,
    private readonly options: DocumentSessionOptions,
    private readonly log: Logger,
  ) {}

  async join(projectId: string, path: string, client: DocumentClient): Promise<DocumentSession> {
    const key = keyOf(projectId, path);
    const held = this.sessions.get(key);

    if (held) {
      held.clients.add(client);
      this.announce(held);
      return held;
    }

    const open = [...this.sessions.values()].filter(
      (session) => session.projectId === projectId,
    ).length;

    if (open >= this.options.maxPerProject) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `This project already has ${this.options.maxPerProject} files open for editing. Close one first.`,
      );
    }

    const file = await this.files.read(projectId, path);

    if (file.encoding !== 'utf8') {
      throw new AppError('BAD_REQUEST', 'This file is not text, so it cannot be edited.', {
        expose: true,
      });
    }

    const session = new DocumentSession(projectId, path, file.entry.version);
    session.text.insert(0, file.content);

    session.doc.on('update', () => {
      session.dirty = true;
      this.schedulePersist(session);
    });

    session.clients.add(client);
    this.sessions.set(key, session);
    this.announce(session);

    this.log.debug({ projectId, path }, 'shared document opened');
    return session;
  }

  applyUpdate(session: DocumentSession, client: DocumentClient, update: Uint8Array): boolean {
    if (!client.canWrite) return false;

    Y.applyUpdate(session.doc, update, client);
    return true;
  }

  async leave(session: DocumentSession, client: DocumentClient): Promise<void> {
    session.clients.delete(client);

    const removed = session.forgetAwareness(client);
    if (removed) {
      for (const other of session.clients) other.send(awarenessFrame(removed));
    }

    if (session.clients.size > 0) {
      this.announce(session);
      return;
    }

    this.clearTimers(session);
    this.sessions.delete(keyOf(session.projectId, session.path));

    await this.persist(session);
    session.doc.destroy();

    this.log.debug({ projectId: session.projectId, path: session.path }, 'shared document closed');
  }

  async closeAll(): Promise<void> {
    const open = [...this.sessions.values()];
    this.sessions.clear();

    for (const session of open) {
      this.clearTimers(session);
      await this.persist(session);
      session.doc.destroy();
    }
  }

  async releaseUser(projectId: string, userId: string): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (session.projectId !== projectId) continue;

      for (const client of [...session.clients]) {
        if (client.userId !== userId) continue;
        await this.leave(session, client);
      }
    }
  }

  private announce(session: DocumentSession): void {
    const participants = session.participants();
    for (const client of session.clients) {
      client.notify({ type: 'participants', participants });
    }
  }

  private clearTimers(session: DocumentSession): void {
    if (session.debounce) clearTimeout(session.debounce);
    if (session.ceiling) clearTimeout(session.ceiling);
    session.debounce = undefined;
    session.ceiling = undefined;
  }

  private schedulePersist(session: DocumentSession): void {
    if (session.stale) return;

    if (session.debounce) clearTimeout(session.debounce);
    session.debounce = setTimeout(() => {
      void this.persist(session);
    }, this.options.saveDebounceMs);

    session.ceiling ??= setTimeout(() => {
      void this.persist(session);
    }, this.options.saveCeilingMs);
  }

  private persist(session: DocumentSession): Promise<void> {
    session.writing = session.writing.then(() => this.write(session));
    return session.writing;
  }

  private async write(session: DocumentSession): Promise<void> {
    this.clearTimers(session);

    if (session.stale || !session.dirty) return;

    const content = session.text.toString();
    session.dirty = false;

    try {
      const entry = await this.files.write(session.projectId, {
        path: session.path,
        content,
        encoding: 'utf8',
        expectedVersion: session.version,
      });

      session.version = entry.version;

      for (const client of session.clients) {
        client.notify({ type: 'saved', at: new Date().toISOString(), version: entry.version });
      }
    } catch (error) {
      session.dirty = true;

      if (error instanceof AppError && error.code === 'CONFLICT') {
        session.stale = true;
        this.clearTimers(session);

        for (const client of session.clients) {
          client.notify({
            type: 'stale',
            message:
              'This file changed outside the editor, so it is no longer being saved here. Copy anything you need, then close and reopen it.',
          });
        }

        this.log.warn(
          { projectId: session.projectId, path: session.path },
          'a shared document went stale: the file changed underneath it',
        );
        return;
      }

      this.log.error(
        { err: error, projectId: session.projectId, path: session.path },
        'a shared document could not be written back',
      );
    }
  }
}

function keyOf(projectId: string, path: string): string {
  return `${projectId} ${path}`;
}

export function awarenessFrame(update: Uint8Array): Uint8Array {
  const frame = new Uint8Array(update.byteLength + 1);
  frame[0] = DOCUMENT_AWARENESS;
  frame.set(update, 1);
  return frame;
}
