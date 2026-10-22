import { useState } from 'react';
import type { AccountSession } from '@platform/shared';
import { fetchSessions, revokeOtherSessions, revokeSession } from '../../lib/account-api.js';
import { ApiError } from '../../lib/api-client.js';
import { signOutEverywhere } from '../../lib/auth-api.js';
import { useAuth } from '../../lib/auth-context.js';
import { useResource } from '../../lib/use-resource.js';
import { SignOut } from '../../ui/icons.js';
import {
  Badge,
  Button,
  ConfirmDialog,
  RelativeTime,
  SectionHeader,
  Table,
  toast,
  type TableColumn,
} from '../../ui/index.js';

/**
 * Where this account is signed in.
 *
 * The one section that answers a question rather than asking for a decision.
 * Somebody who finds a session they do not recognise can end it from its row,
 * end every other one, or end them all including this one. Only the account
 * menu says "Sign out"; here a session is revoked, so the two never read alike.
 */
export function SessionsSection(): React.JSX.Element {
  const { refresh } = useAuth();
  const list = useResource((signal) => fetchSessions(signal), []);
  const sessions = list.data ?? [];
  const others = sessions.filter((session) => !session.current).length;
  const [revoking, setRevoking] = useState<AccountSession | undefined>();
  const [revokingOthers, setRevokingOthers] = useState(false);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);

  const columns: TableColumn<AccountSession>[] = [
    {
      key: 'device',
      header: 'Device',
      cell: (session) => (
        <span className="sessions__device">
          <span title={session.userAgent ?? undefined}>{describeAgent(session.userAgent)}</span>
          {session.current ? <Badge tone="info">This device</Badge> : null}
        </span>
      ),
    },
    {
      key: 'ip',
      header: 'IP address',
      mono: true,
      width: '160px',
      /*
       * The address is shown because it is the field that makes a strange
       * session recognisable as strange, and the only person who ever sees
       * it is the one it is about.
       */
      cell: (session) =>
        session.ipAddress ?? <span className="sessions__unknown">Not recorded</span>,
    },
    {
      key: 'lastSeen',
      header: 'Last used',
      width: '140px',
      cell: (session) => <RelativeTime value={session.lastSeenAt} />,
    },
    {
      key: 'created',
      header: 'Signed in',
      width: '140px',
      cell: (session) => <RelativeTime value={session.createdAt} />,
    },
  ];

  const errorMessage =
    list.status === 'error'
      ? list.error instanceof ApiError
        ? list.error.message
        : 'Your sessions could not be loaded.'
      : undefined;

  return (
    <section className="account-section" aria-labelledby="sessions-heading">
      <SectionHeader
        id="sessions-heading"
        title="Sessions"
        description="Every browser and device where this account is signed in."
        {...(list.data ? { count: sessions.length } : {})}
        action={
          <div className="sessions__actions">
            {others > 0 ? (
              <Button onClick={() => setRevokingOthers(true)}>Revoke other sessions</Button>
            ) : null}
            <Button icon={SignOut} onClick={() => setSigningOutEverywhere(true)}>
              Sign out everywhere
            </Button>
          </div>
        }
      />

      <Table
        caption="Sessions of this account"
        columns={columns}
        rows={sessions}
        rowKey={(session) => session.id}
        loading={list.status === 'loading'}
        {...(errorMessage ? { error: errorMessage, onRetry: list.reload } : {})}
        rowName={(session) => describeAgent(session.userAgent)}
        rowActions={(session) => [
          {
            label: 'Revoke session on',
            icon: SignOut,
            tone: 'danger',
            onSelect: () => setRevoking(session),
          },
        ]}
        // Never empty: the session reading this list is always in it.
        empty={{ icon: SignOut, title: 'No sessions.' }}
      />

      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        tone="danger"
        title={revoking ? `Revoke the session on ${describeAgent(revoking.userAgent)}?` : ''}
        body={
          revoking?.current
            ? 'This is the device you are using now, so you will be signed out here.'
            : 'That browser is signed out at once and has to sign in again.'
        }
        confirmLabel="Revoke session"
        onConfirm={async () => {
          if (!revoking) return;
          await revokeSession(revoking.id);
          if (revoking.current) {
            // The session that just ended was this one. Asking who we are now
            // is what moves the app back to a signed-out shell.
            await refresh();
            return;
          }
          list.reload();
          toast({ tone: 'success', title: 'Session revoked' });
        }}
      />

      <ConfirmDialog
        open={revokingOthers}
        onOpenChange={setRevokingOthers}
        tone="danger"
        title={others === 1 ? 'Revoke the other session?' : `Revoke the other ${others} sessions?`}
        body="Every session except this one ends now. You stay signed in here."
        confirmLabel="Revoke other sessions"
        onConfirm={async () => {
          const signedOut = await revokeOtherSessions();
          list.reload();
          toast({
            tone: 'success',
            title:
              signedOut === 1
                ? 'One other session was revoked'
                : `${signedOut} other sessions were revoked`,
          });
        }}
      />

      <ConfirmDialog
        open={signingOutEverywhere}
        onOpenChange={setSigningOutEverywhere}
        tone="danger"
        title="Sign out everywhere?"
        body="Every session ends, including this one. You will need to sign in again."
        confirmLabel="Sign out everywhere"
        onConfirm={async () => {
          await signOutEverywhere();
          await refresh();
        }}
      />
    </section>
  );
}

/**
 * A browser and platform, from a user-agent string.
 *
 * Rough on purpose. The string is whatever the client sent and parsing it
 * properly is a library and a losing battle; the person reading this needs to
 * tell one of their own devices from a machine they have never used, and a
 * couple of words does that. The whole string stays in the title attribute for
 * anyone who wants it.
 */
export function describeAgent(userAgent: string | null): string {
  if (!userAgent) return 'An unnamed client';

  const browser = /\bEdg\//.test(userAgent)
    ? 'Edge'
    : /\bChrome\//.test(userAgent)
      ? 'Chrome'
      : /\bFirefox\//.test(userAgent)
        ? 'Firefox'
        : /\bSafari\//.test(userAgent)
          ? 'Safari'
          : 'A browser';

  const platform = /\bAndroid\b/.test(userAgent)
    ? 'Android'
    : /\b(iPhone|iPad)\b/.test(userAgent)
      ? 'iOS'
      : /\bMac OS X\b/.test(userAgent)
        ? 'macOS'
        : /\bWindows\b/.test(userAgent)
          ? 'Windows'
          : /\bLinux\b/.test(userAgent)
            ? 'Linux'
            : undefined;

  return platform ? `${browser} on ${platform}` : browser;
}
