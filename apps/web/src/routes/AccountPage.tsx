import { useCallback, useEffect, useState } from 'react';
import {
  PASSWORD_MIN_LENGTH,
  type AccountSession,
  type TwoFactorStatus,
  type VerificationStatus,
} from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth-context.js';
import { fieldErrorsFrom, type FieldErrors } from '../lib/form-errors.js';
import { fetchVerificationStatus, sendVerificationEmail } from '../lib/verification-api.js';
import QRCode from 'qrcode';
import {
  beginTwoFactor,
  confirmTwoFactor,
  disableTwoFactor,
  fetchTwoFactorStatus,
  changePassword,
  deleteAccount,
  fetchSessions,
  revokeOtherSessions,
  revokeSession,
} from '../lib/account-api.js';
import '../styles/projects.css';
import '../styles/form.css';

/**
 * Your account.
 *
 * Three things, and they read as one page because they are one worry. Somebody
 * arrives here because they think their password may be known, and the order
 * answers that worry in the order it occurs: where am I signed in, change the
 * password, and — for the person who has decided to leave — close the account.
 *
 * Deliberately not a settings page. Changing a display name is housekeeping;
 * everything here is consequential, and mixing the two teaches people to click
 * through this screen quickly.
 */
export function AccountPage(): React.JSX.Element {
  const { user, refresh } = useAuth();

  return (
    <section className="account">
      <header className="account__header">
        <h1>Your account</h1>
        <p className="project-section__hint">
          {user ? `Signed in as ${user.username}.` : 'Signed in.'} Everything on this page affects
          this account only.
        </p>
      </header>

      <EmailPanel />
      <SessionsPanel />
      <PasswordPanel />
      <TwoFactorPanel />
      <DangerPanel username={user?.username} onDeleted={refresh} />
    </section>
  );
}

/**
 * The address on the account, and whether it has been proved.
 *
 * First, because it is the shortest and because an unproved address is the
 * thing that quietly breaks the panel below it: a reset link is only useful if
 * it reaches the right person.
 *
 * It never offers a button that cannot work. An installation with no mail
 * server says so and explains, which is the difference between a feature that
 * is missing and one that is broken.
 */
function EmailPanel(): React.JSX.Element | null {
  const [status, setStatus] = useState<VerificationStatus | undefined>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const controller = new AbortController();

    fetchVerificationStatus(controller.signal)
      .then(setStatus)
      .catch(() => {
        /*
         * Shown as nothing rather than as an error.
         *
         * This panel is context, and a failure to load it should not put a red
         * message above somebody's sessions. Everything below it still works.
         */
      });

    return () => controller.abort();
  }, []);

  if (!status) return null;

  return (
    <section className="project-section">
      <div className="project-section__actions">
        <h2>Email address</h2>
      </div>

      <p className="project-section__hint">
        {status.email}
        {status.verified ? ' — confirmed.' : ' — not confirmed yet.'}
      </p>

      {!status.verified && !status.canSend && (
        <p className="project-section__hint">
          {status.reason ?? 'This installation cannot send email.'}
        </p>
      )}

      {!status.verified && status.canSend && (
        <>
          <p className="project-section__hint">
            Confirming your address is what makes a password reset able to reach you.
          </p>
          <button
            type="button"
            className="button-quiet"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setNote(undefined);
              setError(undefined);

              sendVerificationEmail()
                .then(() => setNote('A link is on its way. It stops working after a while.'))
                .catch((cause: unknown) => {
                  setError(
                    cause instanceof ApiError ? cause.message : 'The message could not be sent.',
                  );
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Sending…' : 'Send me a confirmation link'}
          </button>
        </>
      )}

      {note && <p className="project-section__note">{note}</p>}
      {error && <p className="project-section__error">{error}</p>}
    </section>
  );
}

/**
 * Where this account is signed in.
 *
 * First on the page because it is the one panel that answers a question rather
 * than asking for a decision. Somebody who finds a session they do not
 * recognise now knows they need the panel below.
 */
function SessionsPanel(): React.JSX.Element {
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const listed = await fetchSessions(signal);
      if (signal?.aborted) return;
      setSessions(listed);
      setError(undefined);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof ApiError ? cause.message : 'Your sessions could not be loaded.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const others = sessions.filter((session) => !session.current).length;

  return (
    <section className="project-section">
      <header className="project-section__actions">
        <h2>Where you are signed in</h2>
        {others > 0 && (
          <button
            type="button"
            className="button-quiet"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setNote(undefined);
              revokeOtherSessions()
                .then((signedOut) => {
                  setNote(
                    signedOut === 1
                      ? 'One other session was signed out.'
                      : `${signedOut} other sessions were signed out.`,
                  );
                  return load();
                })
                .catch((cause: unknown) => {
                  setError(
                    cause instanceof ApiError
                      ? cause.message
                      : 'Those sessions could not be ended.',
                  );
                })
                .finally(() => setBusy(false));
            }}
          >
            Sign out everywhere else
          </button>
        )}
      </header>

      {loading && <p className="project-section__hint">Loading…</p>}
      {error && <p className="project-section__error">{error}</p>}
      {note && <p className="project-section__hint">{note}</p>}

      {!loading && sessions.length > 0 && (
        <ul className="project-section__list">
          {sessions.map((session) => (
            <li key={session.id} className="project-section__item">
              <div>
                <p className="project-section__item-name">
                  {describeAgent(session.userAgent)}
                  {session.current && (
                    <span className="project-section__item-meta"> this device</span>
                  )}
                </p>
                <p className="project-section__hint">
                  {/*
                   * The address is shown because it is the field that makes a
                   * strange session recognisable as strange, and the only person
                   * who ever sees it is the one it is about.
                   */}
                  {session.ipAddress ?? 'address not recorded'} · last used{' '}
                  {formatWhen(session.lastSeenAt)} · signed in {formatWhen(session.createdAt)}
                </p>
              </div>
              <button
                type="button"
                className="button-quiet"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  revokeSession(session.id)
                    .then(() => load())
                    .catch((cause: unknown) => {
                      setError(
                        cause instanceof ApiError
                          ? cause.message
                          : 'That session could not be ended.',
                      );
                    })
                    .finally(() => setBusy(false));
                }}
              >
                {session.current ? 'Sign out' : 'End'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PasswordPanel(): React.JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState<string | undefined>();

  return (
    <section className="project-section">
      <header className="project-section__actions">
        <h2>Change your password</h2>
      </header>

      <form
        className="project-section__form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          setFieldErrors({});
          setDone(undefined);

          changePassword({ currentPassword, newPassword, signOutOthers })
            .then((signedOut) => {
              setCurrentPassword('');
              setNewPassword('');
              setDone(
                signedOut > 0
                  ? `Password changed. ${signedOut === 1 ? 'One other session was' : `${signedOut} other sessions were`} signed out.`
                  : 'Password changed.',
              );
            })
            .catch((cause: unknown) => {
              if (cause instanceof ApiError) {
                const { fields, message } = fieldErrorsFrom(cause);
                setFieldErrors(fields);
                setError(message ?? cause.message);
                return;
              }
              setError('The password could not be changed.');
            })
            .finally(() => setBusy(false));
        }}
      >
        <label className="field">
          <span>Current password</span>
          <input
            type="password"
            className="input"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
          {fieldErrors.currentPassword && (
            <span className="project-section__error">{fieldErrors.currentPassword}</span>
          )}
        </label>

        <label className="field">
          <span>New password</span>
          <input
            type="password"
            className="input"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            minLength={PASSWORD_MIN_LENGTH}
            required
          />
          {fieldErrors.newPassword && (
            <span className="project-section__error">{fieldErrors.newPassword}</span>
          )}
        </label>

        <label className="account__check">
          <input
            type="checkbox"
            checked={signOutOthers}
            onChange={(event) => setSignOutOthers(event.target.checked)}
          />
          {/*
           * On by default, and offered rather than forced. Somebody changing a
           * password because it may be known wants every other browser signed
           * out; somebody doing housekeeping may have a phone they would rather
           * not sign in on again. Only they know which they are.
           */}
          <span>Sign out everywhere else</span>
        </label>

        {error && <p className="project-section__error">{error}</p>}
        {done && <p className="project-section__note">{done}</p>}

        <button type="submit" className="button-primary" disabled={busy}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}

/**
 * A second factor at sign-in.
 *
 * Three states, and the page is honest about each: off (and whether it can be
 * turned on here at all), half-set-up (a secret shown, waiting for a code that
 * proves the app has it), and on. The recovery codes appear exactly once, at the
 * moment it is turned on, and the page says so — there is no way to see them
 * again, by design.
 */
function TwoFactorPanel(): React.JSX.Element | null {
  const [status, setStatus] = useState<TwoFactorStatus | undefined>();
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | undefined>();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setStatus(await fetchTwoFactorStatus().catch(() => undefined));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return null;

  const fail = (cause: unknown, fallback: string) => {
    setError(cause instanceof ApiError ? cause.message : fallback);
    setBusy(false);
  };

  return (
    <section className="project-section">
      <div className="project-section__actions">
        <h2>Two-factor sign-in</h2>
      </div>

      {!status.available && (
        <p className="project-section__hint">
          This installation has no encryption key configured, so a second factor cannot be stored
          here.
        </p>
      )}

      {recoveryCodes && (
        <div className="project-section__note">
          <p>
            <strong>Save these recovery codes now.</strong> Each works once, instead of a code from
            your app, if you lose your phone. They will not be shown again.
          </p>
          <pre>{recoveryCodes.join('\n')}</pre>
        </div>
      )}

      {status.available && !status.enabled && !setup && (
        <>
          <p className="project-section__hint">
            With this on, your password alone cannot sign in: a code from an authenticator app is
            needed too.
          </p>
          <button
            type="button"
            className="button-quiet"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              beginTwoFactor()
                .then(async (started) => {
                  // Drawn here, in the browser: the secret never goes anywhere
                  // to be turned into a picture.
                  const qr = await QRCode.toDataURL(started.uri, { margin: 1, width: 200 });
                  setSetup({ ...started, qr });
                  setBusy(false);
                })
                .catch((cause: unknown) => fail(cause, 'A second factor could not be started.'));
            }}
          >
            Turn on two-factor sign-in
          </button>
        </>
      )}

      {setup && !status.enabled && (
        <form
          className="project-section__form"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(undefined);
            confirmTwoFactor(code.trim())
              .then(async (codes) => {
                setRecoveryCodes(codes);
                setSetup(undefined);
                setCode('');
                await load();
                setBusy(false);
              })
              .catch((cause: unknown) => fail(cause, 'That code could not be checked.'));
          }}
        >
          <p className="project-section__hint">
            Scan this with your authenticator app, or type the key in by hand. Then enter the code
            it shows.
          </p>
          <img src={setup.qr} alt="A QR code for your authenticator app" width={200} height={200} />
          <p className="project-section__item-meta">
            <code>{setup.secret}</code>
          </p>
          <label className="field">
            <span>Code from the app</span>
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="button-primary"
            disabled={busy || code.trim().length < 6}
          >
            Turn it on
          </button>
        </form>
      )}

      {status.enabled && (
        <form
          className="project-section__form"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(undefined);
            disableTwoFactor(password, code.trim())
              .then(async () => {
                setPassword('');
                setCode('');
                setRecoveryCodes(undefined);
                await load();
                setBusy(false);
              })
              .catch((cause: unknown) => fail(cause, 'It could not be turned off.'));
          }}
        >
          <p className="project-section__hint">
            On. {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? '' : 's'}{' '}
            left. Turning it off needs your password and a current code.
          </p>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Code, or a recovery code</span>
            <input
              className="input"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button type="submit" className="button-danger" disabled={busy || !password || !code}>
            Turn off two-factor sign-in
          </button>
        </form>
      )}

      {error && <p className="project-section__error">{error}</p>}
    </section>
  );
}

/**
 * Closing the account.
 *
 * Last, visually separated, and it asks for two different things: the password,
 * which proves who is asking, and the username typed out, which proves they
 * meant it. Only the second protects against a tired person, and it is the only
 * protection there is — nothing about this is reversible.
 */
function DangerPanel({
  username,
  onDeleted,
}: {
  username: string | undefined;
  onDeleted: () => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmUsername, setConfirmUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  return (
    <section className="danger-zone">
      <header className="project-section__actions">
        <h2>Close this account</h2>
      </header>

      <p className="project-section__hint">
        Every project you own is deleted, along with its files, history, snapshots, database and
        anything deployed from it. People you shared those projects with lose access. Projects owned
        by somebody else are not affected. This cannot be undone.
      </p>

      {!open && (
        <button type="button" className="button-danger" onClick={() => setOpen(true)}>
          Close account…
        </button>
      )}

      {open && (
        <form
          className="project-section__form"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(undefined);

            deleteAccount({ password, confirmUsername })
              .then(() => {
                // The session went with the account. Asking who we are now is
                // what moves the app back to a signed-out shell.
                return onDeleted();
              })
              .catch((cause: unknown) => {
                setError(
                  cause instanceof ApiError ? cause.message : 'The account could not be closed.',
                );
                setBusy(false);
              });
          }}
        >
          <label className="field">
            <span>Your password</span>
            <input
              type="password"
              className="input"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          <label className="field">
            <span>Type {username ?? 'your username'} to confirm</span>
            <input
              type="text"
              className="input"
              autoComplete="off"
              value={confirmUsername}
              onChange={(event) => setConfirmUsername(event.target.value)}
              required
            />
          </label>

          {error && <p className="project-section__error">{error}</p>}

          <div className="danger-zone__actions">
            <button
              type="submit"
              className="button-danger"
              disabled={busy || confirmUsername.trim().toLowerCase() !== username?.toLowerCase()}
            >
              {busy ? 'Closing…' : 'Close this account permanently'}
            </button>
            <button type="button" className="button-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
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
function describeAgent(userAgent: string | null): React.JSX.Element {
  if (!userAgent) return <span>An unnamed client</span>;

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

  return <span title={userAgent}>{platform ? `${browser} on ${platform}` : browser}</span>;
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'at an unknown time';

  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
