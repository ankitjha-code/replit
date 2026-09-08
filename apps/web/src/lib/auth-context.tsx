import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { LoginRequest, PublicUser, RegisterRequest } from '@platform/shared';
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

export interface AuthState {
  status: AuthStatus;
  user: PublicUser | null;
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

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('unknown');
  const [user, setUser] = useState<PublicUser | null>(null);

  const apply = useCallback((next: PublicUser | null) => {
    setUser(next);
    setStatus(next ? 'authenticated' : 'anonymous');
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    authApi
      .fetchCurrentUser(controller.signal)
      .then(apply)
      .catch(() => {
        if (controller.signal.aborted) return;
        // The server is unreachable or answered something unusable. Treating
        // that as signed out is the safe reading: nothing here grants access,
        // and the server decides on every request anyway.
        apply(null);
      });

    return () => controller.abort();
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
      apply(null);
    }
  }, [apply]);

  const refresh = useCallback(async () => {
    apply(await authApi.fetchCurrentUser().catch(() => null));
  }, [apply]);

  const value = useMemo<AuthState>(
    () => ({ status, user, signIn, completeTwoFactor, register, signOut, refresh }),
    [status, user, signIn, completeTwoFactor, register, signOut, refresh],
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
