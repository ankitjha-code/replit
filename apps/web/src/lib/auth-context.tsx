import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { LoginRequest, PublicUser, RegisterRequest } from '@platform/shared';
import { ApiError, onUnauthorized } from './api-client.js';
import * as authApi from './auth-api.js';

/**
 * Who is signed in, for the whole application.
 *
 * The session lives in an httpOnly cookie, so the browser cannot inspect it.
 * This state is a cache of what the server said, never the authority: every
 * protected request is checked server-side regardless of what is held here.
 *
 * `unknown` is a distinct state from `anonymous` on purpose. On first load the
 * answer has not arrived yet, and rendering a signed-out view during that
 * moment makes the page flash from signed-out to signed-in.
 */
export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous';

/** Why the status became anonymous, when it was not the user's own doing. */
export type AnonymousReason = 'expired';

export interface AuthState {
  status: AuthStatus;
  user: PublicUser | null;
  /** Set when the session ended underneath the user; cleared on the next sign-in. */
  reason: AnonymousReason | null;
  /**
   * False when the server could not be reached at all, so a signed-out view
   * can say "unknown" rather than claim the user is signed out.
   */
  reachable: boolean;
  /**
   * True while a signed-in page has learned its session is gone but is kept
   * mounted so unsaved work is not lost. The shell shows a banner, and the
   * provider re-reads `/me` until the session is back or `expireSession` runs.
   */
  sessionEnded: boolean;
  /** Gives up on an ended session: anonymous, with `reason: 'expired'`. */
  expireSession: () => void;
  /**
   * Signs in. Resolves with the user, or with a challenge when the account has
   * a second factor and a code is still owed.
   */
  signIn: (input: LoginRequest) => Promise<{ user: PublicUser } | { challenge: string }>;
  /** Finishes a sign-in that asked for a code. */
  completeTwoFactor: (challenge: string, code: string) => Promise<PublicUser>;
  register: (input: RegisterRequest) => Promise<PublicUser>;
  signOut: () => Promise<void>;
  /** Re-reads from the server, for when the session may have changed elsewhere. */
  refresh: () => Promise<void>;
}

/** Dispatched on `window` when an ended session is found to be live again. */
export const SESSION_RESTORED_EVENT = 'session:restored';

/** How often an ended session is re-checked while its banner is up. */
export const SESSION_REPOLL_MS = 15_000;

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('unknown');
  const [user, setUser] = useState<PublicUser | null>(null);
  const [reason, setReason] = useState<AnonymousReason | null>(null);
  const [reachable, setReachable] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  // The 401 handler is registered once and must see the current status.
  const statusRef = useRef(status);
  statusRef.current = status;

  const apply = useCallback((next: PublicUser | null) => {
    setUser(next);
    setStatus(next ? 'authenticated' : 'anonymous');
    if (next) setReason(null);
  }, []);

  /** Reads `/me`; records whether the server answered at all. */
  const read = useCallback(async (signal?: AbortSignal): Promise<PublicUser | null> => {
    try {
      const current = await authApi.fetchCurrentUser(signal);
      setReachable(true);
      return current;
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) setReachable(false);
      // The server is unreachable or answered something unusable. Treating
      // that as signed out is the safe reading: nothing here grants access,
      // and the server decides on every request anyway.
      return null;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal).then((current) => {
      if (!controller.signal.aborted) apply(current);
    });
    return () => controller.abort();
  }, [apply, read]);

  useEffect(
    () =>
      onUnauthorized((_error, path) => {
        // A wrong password on the sign-in form is also a 401; only a 401 while
        // signed in means the session is gone.
        if (statusRef.current !== 'authenticated') return;
        if (path.startsWith('/api/auth/login')) return;
        setSessionEnded(true);
      }),
    [],
  );

  // While the banner is up, keep asking whether the session came back (the
  // user may sign in again in another tab).
  useEffect(() => {
    if (!sessionEnded) return;
    const timer = setInterval(() => {
      void read().then((current) => {
        if (!current) return;
        apply(current);
        setSessionEnded(false);
        window.dispatchEvent(new Event(SESSION_RESTORED_EVENT));
      });
    }, SESSION_REPOLL_MS);
    return () => clearInterval(timer);
  }, [sessionEnded, read, apply]);

  const expireSession = useCallback(() => {
    setSessionEnded(false);
    apply(null);
    setReason('expired');
  }, [apply]);

  const signIn = useCallback(
    async (input: LoginRequest) => {
      const answer = await authApi.signIn(input);
      if ('twoFactorRequired' in answer) return { challenge: answer.challenge };
      apply(answer.user);
      return { user: answer.user };
    },
    [apply],
  );

  const completeTwoFactor = useCallback(
    async (challenge: string, code: string) => {
      const { user: signedIn } = await authApi.completeTwoFactor(challenge, code);
      apply(signedIn);
      return signedIn;
    },
    [apply],
  );

  const register = useCallback(
    async (input: RegisterRequest) => {
      // Registration signs the user in, so the state moves the same way.
      const { user: created } = await authApi.registerAccount(input);
      apply(created);
      return created;
    },
    [apply],
  );

  /**
   * Signs out, and never rejects.
   *
   * The local state is cleared either way, because the user asked to leave and
   * continuing to show a signed-in view ignores that. If the request failed the
   * cookie may still be valid on the server, but that self-corrects: the next
   * read of the current user returns the truth.
   *
   * Not rejecting is deliberate. Every caller is a click handler, and a
   * rejected promise from one is an unhandled rejection, not something a
   * button can usefully act on.
   */
  const signOut = useCallback(async () => {
    try {
      await authApi.signOut();
    } catch {
      // Intentionally swallowed; the state change above is the response the
      // user needs, and the server is re-consulted on the next request.
    } finally {
      setSessionEnded(false);
      apply(null);
    }
  }, [apply]);

  const refresh = useCallback(async () => {
    apply(await read());
  }, [apply, read]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      reason,
      reachable,
      sessionEnded,
      expireSession,
      signIn,
      completeTwoFactor,
      register,
      signOut,
      refresh,
    }),
    [
      status,
      user,
      reason,
      reachable,
      sessionEnded,
      expireSession,
      signIn,
      completeTwoFactor,
      register,
      signOut,
      refresh,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return context;
}
