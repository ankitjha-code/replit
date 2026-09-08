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

/**
 * Shared documents: one live CRDT per file that somebody has open.
 *
 * The platform holds the authoritative copy in memory for as long as at least
 * one editor is attached, and writes it back to the project's files as the
 * typing settles. That split is the whole design:
 *
 *  - **The database remains the source of truth for what a project contains.**
 *    A CRDT is not a store. It is excellent at merging concurrent edits and has
 *    nothing to say about anything else here: a container is seeded from the
 *    files table, a snapshot is taken from it, a commit is made from it. Making
 *    the document the authority would put every one of those behind a text
 *    object held in one process's memory.
 *  - **The document is the authority on the text while it is open**, because
 *    that is the only period during which two people can be typing, which is
 *    the only problem it exists to solve.
 *
 * Nothing is persisted as a CRDT. What reaches the database is plain text, so a
 * file written collaboratively is afterwards indistinguishable from one written
 * alone. Storing the CRDT would make every other part of the platform depend on
 * being able to decode one.
 */

export interface DocumentSessionOptions {
  /** Files one project may have open at once, across everybody in it. */
  maxPerProject: number;
  /** How long after the last keystroke the document is written back. */
  saveDebounceMs: number;
  /** How long typing can continue before a save happens regardless. */
  saveCeilingMs: number;
}

/**
 * One attached editor, as the service sees it.
 *
 * Deliberately not a WebSocket. The service decides what happens to a document
 * and the gateway decides how bytes reach a browser; a socket in here would
 * make the rules untestable without a server.
 */
export interface DocumentClient {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  /** Whether this client's updates are accepted. Decided at upgrade. */
  readonly canWrite: boolean;
  /** A binary sync frame, already carrying its type byte. */
  send(frame: Uint8Array): void;
  /** A JSON control message. */
  notify(message: DocumentNotice): void;
}

export type DocumentNotice =
  | { type: 'participants'; participants: DocumentParticipant[] }
  | { type: 'saved'; at: string; version: number }
  | { type: 'stale'; message: string };

export class DocumentSession {
  readonly doc = new Y.Doc();
  readonly clients = new Set<DocumentClient>();

  /**
   * Where everybody's cursor is, kept on the server.
   *
   * Kept rather than only relayed so somebody who opens the file sees the
   * cursors already there, and so a participant who disconnects without saying
   * goodbye has their cursor removed rather than frozen on everybody's screen.
   */
  readonly awareness = new Awareness(this.doc);

  /**
   * Which awareness identities each connection has spoken for.
   *
   * An awareness identity is a random number a client picks. Without this, one
   * client could send an update under another's number and move or erase that
   * person's cursor. The first connection to use a number owns it.
   */
  readonly awarenessOwners = new Map<number, DocumentClient>();

  /**
   * The file version this session last wrote, or loaded.
   *
   * What makes an outside change detectable. Every save is conditional on it,
   * so a restore or a read-back from a container cannot be silently overwritten
   * by a session that happened to be open while it landed.
   */
  version: number;

  /**
   * True once something changed the file underneath this session.
   *
   * The session then stops writing. It does not close: everything typed is
   * still in every attached editor, and closing would discard it. It stops
   * claiming to be saving, which is the honest half.
   */
  stale = false;

  /** Whether anything has changed since the last successful write. */
  dirty = false;

  debounce: ReturnType<typeof setTimeout> | undefined;
  ceiling: ReturnType<typeof setTimeout> | undefined;

  /** Serialises writes, so two saves cannot interleave on one file. */
  writing: Promise<void> = Promise.resolve();

  constructor(
    readonly projectId: string,
    readonly path: string,
    version: number,
  ) {
    this.version = version;
  }

  get text(): Y.Text {
    // One named root, fixed, because both ends have to agree on it and a
    // document with two roots would be two documents.
    return this.doc.getText('content');
  }

  /**
   * Takes one client's awareness update, trusting nothing in it but positions.
   *
   * Refused entirely if it touches an identity another connection owns. The
   * name and colour in every accepted state are replaced with the account's own,
   * because they are displayed to everybody and a client-chosen name is a way
   * to appear to be somebody else. Returns what to send to the others, or
   * undefined when there is nothing to send.
   */
  acceptAwareness(client: DocumentClient, update: Uint8Array): Uint8Array | undefined {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const touched: number[] = [];
    for (let index = 0; index < count; index += 1) {
      touched.push(decoding.readVarUint(decoder));
      decoding.readVarUint(decoder); // clock
      decoding.readVarString(decoder); // state
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

  /** Everybody's current cursors, for somebody who has just opened the file. */
  awarenessSnapshot(): Uint8Array | undefined {
    const ids = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    return ids.length > 0 ? encodeAwarenessUpdate(this.awareness, ids) : undefined;
  }

  /** Forgets one connection's cursors, and returns the update that says so. */
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
        // Somebody with the same file open twice is one participant. Merged the
        // permissive way rather than by whichever window arrived first.
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
  /** Open documents, keyed by project and path. */
  private readonly sessions = new Map<string, DocumentSession>();

  constructor(
    private readonly files: FileService,
    private readonly options: DocumentSessionOptions,
    private readonly log: Logger,
  ) {}

  /**
   * Attaches an editor to a file, loading it if this is the first one.
   *
   * The initial content comes from the database exactly once per session. Every
   * later editor is caught up from the live document instead, because the live
   * document is ahead: it holds characters typed and not yet written back.
   */
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

    // Throws NOT_FOUND for a missing path and BAD_REQUEST for a directory,
    // which the gateway turns into its own refusal codes.
    const file = await this.files.read(projectId, path);

    if (file.encoding !== 'utf8') {
      throw new AppError('BAD_REQUEST', 'This file is not text, so it cannot be edited.', {
        expose: true,
      });
    }

    const session = new DocumentSession(projectId, path, file.entry.version);
    session.text.insert(0, file.content);

    /*
     * Observed after seeding, not before.
     *
     * The insert above is itself an update, and a session that marked itself
     * dirty for loading a file would write that file straight back out on the
     * first save and burn a version for nothing.
     */
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

  /**
   * Applies one client's update.
   *
   * Returns false when the update is refused, which happens for a client
   * without write access. Refused rather than applied-and-not-saved: applying
   * it would put the characters on everybody else's screen and then lose them,
   * which is the worst of both.
   */
  applyUpdate(session: DocumentSession, client: DocumentClient, update: Uint8Array): boolean {
    if (!client.canWrite) return false;

    // The client is recorded as the origin, so the gateway can avoid echoing an
    // update back to the editor that produced it.
    Y.applyUpdate(session.doc, update, client);
    return true;
  }

  /**
   * Detaches an editor, and writes the file back when it was the last one.
   *
   * Flushed immediately rather than left to the debounce: the session is about
   * to stop existing, and a timer on an object nobody holds is a way to lose
   * the last thing somebody typed.
   */
  async leave(session: DocumentSession, client: DocumentClient): Promise<void> {
    session.clients.delete(client);

    // Their cursor goes with them, rather than staying frozen on every screen.
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

  /** Writes back and releases every open document, for shutdown. */
  async closeAll(): Promise<void> {
    const open = [...this.sessions.values()];
    this.sessions.clear();

    for (const session of open) {
      this.clearTimers(session);
      /*
       * Written back before the process goes.
       *
       * A shared document is the one piece of state in this platform that lives
       * only in memory, so a shutdown that skipped this would lose work that
       * every other path already treats as saved.
       */
      await this.persist(session);
      session.doc.destroy();
    }
  }

  /**
   * Drops every editor belonging to one person in one project.
   *
   * Called when their access changes. The gateway closes their sockets; this
   * forgets them, so a document nobody is left holding is written back and
   * released rather than kept open by a membership that no longer exists.
   */
  async releaseUser(projectId: string, userId: string): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (session.projectId !== projectId) continue;

      for (const client of [...session.clients]) {
        if (client.userId !== userId) continue;
        await this.leave(session, client);
      }
    }
  }

  // -------------------------------------------------------------------------

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

  /**
   * Arranges for a write once the typing settles.
   *
   * Two timers, exactly as the editor's own autosave has: one restarted on
   * every keystroke, and one that is not. Without the second, somebody typing
   * continuously for ten minutes has nothing written down for ten minutes.
   */
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

  /**
   * Writes the document back to the project's files.
   *
   * Never throws. It is called from timers and from shutdown, where there is
   * nobody to catch.
   */
  private persist(session: DocumentSession): Promise<void> {
    // Chained rather than concurrent: two writes to one path racing would make
    // the version check below meaningless.
    session.writing = session.writing.then(() => this.write(session));
    return session.writing;
  }

  /**
   * One write, conditional on the version this session last saw.
   *
   * That condition is what makes an outside change a refusal rather than a
   * silent overwrite. A restore, a read-back from a container, or a write
   * through the API all move the version, and a session holding text from
   * before that would otherwise replace their work with what it had in memory.
   */
  private async write(session: DocumentSession): Promise<void> {
    this.clearTimers(session);

    if (session.stale || !session.dirty) return;

    const content = session.text.toString();
    /*
     * Cleared before the write, not after.
     *
     * A keystroke landing while the write is in flight must leave the session
     * dirty again, rather than be forgotten because the write that did not
     * include it succeeded.
     */
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
        /*
         * Something else wrote this file.
         *
         * The session stops saving rather than overwriting it. Everything typed
         * is still on every attached screen, so nothing is lost yet, but it is
         * no longer being written down and saying so is the only honest option.
         * Reopening the file starts a session from what is now stored.
         */
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

/** An awareness update with its frame type in front. */
export function awarenessFrame(update: Uint8Array): Uint8Array {
  const frame = new Uint8Array(update.byteLength + 1);
  frame[0] = DOCUMENT_AWARENESS;
  frame.set(update, 1);
  return frame;
}
