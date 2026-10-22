import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { participantColour } from '@platform/shared';
import { DocumentSession, type DocumentClient } from './document-session.service.js';

function client(userId: string, username: string): DocumentClient {
  return {
    userId,
    username,
    displayName: '',
    canWrite: true,
    send: () => undefined,
    notify: () => undefined,
  };
}

/** A browser's awareness update, claiming whatever it likes. */
function claim(clientId: number, state: Record<string, unknown>): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  const awareness = new Awareness(doc);
  awareness.setLocalState(state);
  return encodeAwarenessUpdate(awareness, [clientId]);
}

/** What another browser would see after applying the server's update. */
function seenBy(update: Uint8Array): Map<number, Record<string, unknown>> {
  const awareness = new Awareness(new Y.Doc());
  applyAwarenessUpdate(awareness, update, 'server');
  return awareness.getStates() as Map<number, Record<string, unknown>>;
}

describe('shared cursors', () => {
  it('replaces the name and colour a client chose with the account’s own', () => {
    // A client-chosen name is a way to appear to be somebody else, and a
    // client-chosen colour is a string that would end up in a stylesheet.
    const session = new DocumentSession('p-1', 'a.ts', 1);
    const ada = client('u-ada', 'ada');

    const out = session.acceptAwareness(
      ada,
      claim(101, {
        cursor: { anchor: 3 },
        user: { name: 'the administrator', colour: 'red;}body{display:none' },
      }),
    );

    const state = seenBy(out!).get(101)!;
    expect(state.user).toEqual({ name: 'ada', colour: participantColour('u-ada') });
    expect(state.cursor).toEqual({ anchor: 3 });
  });

  it('refuses an update that speaks for somebody else’s cursor', () => {
    const session = new DocumentSession('p-1', 'a.ts', 1);
    const ada = client('u-ada', 'ada');
    const eve = client('u-eve', 'eve');

    session.acceptAwareness(ada, claim(101, { cursor: { anchor: 1 } }));

    // Eve reuses Ada's identity to move — or erase — Ada's cursor.
    expect(session.acceptAwareness(eve, claim(101, { cursor: { anchor: 99 } }))).toBeUndefined();
  });

  it('forgets a client’s cursors when it leaves', () => {
    const session = new DocumentSession('p-1', 'a.ts', 1);
    const ada = client('u-ada', 'ada');
    session.acceptAwareness(ada, claim(101, { cursor: { anchor: 1 } }));

    expect(session.forgetAwareness(ada)).toBeDefined();
    expect(session.awarenessSnapshot()).toBeUndefined();
  });

  it('gives a newcomer the cursors already there', () => {
    const session = new DocumentSession('p-1', 'a.ts', 1);
    session.acceptAwareness(client('u-ada', 'ada'), claim(101, { cursor: { anchor: 1 } }));

    const snapshot = session.awarenessSnapshot();
    expect(seenBy(snapshot!).has(101)).toBe(true);
  });
});
