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

export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous';

export type AnonymousReason = 'expired';

export interface AuthState {
  status: AuthStatus;
  user: PublicUser | null;
  reason: AnonymousReason | null;
  reachable: boolean;
  sessionEnded: boolean;
  expireSession: () => void;
  signIn: (input: LoginRequest) => Promise<{ user: PublicUser } | { challenge: string }>;
  completeTwoFactor: (challenge: string, code: string) => Promise<PublicUser>;
  register: (input: RegisterRequest) => Promise<PublicUser>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const SESSION_RESTORED_EVENT = 'session:restored';

export const SESSION_REPOLL_MS = 15_000;

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('unknown');
  const [user, setUser] = useState<PublicUser | null>(null);
  const [reason, setReason] = useState<AnonymousReason | null>(null);
  const [reachable, setReachable] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  const apply = useCallback((next: PublicUser | null) => {
    setUser(next);
    setStatus(next ? 'authenticated' : 'anonymous');
    if (next) setReason(null);
  }, []);

  const read = useCallback(async (signal?: AbortSignal): Promise<PublicUser | null> => {
    try {
      const current = await authApi.fetchCurrentUser(signal);
      setReachable(true);
      return current;
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) setReachable(false);
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
        if (statusRef.current !== 'authenticated') return;
        if (path.startsWith('/api/auth/login')) return;
        setSessionEnded(true);
      }),
    [],
  );

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
      const { user: created } = await authApi.registerAccount(input);
      apply(created);
      return created;
    },
    [apply],
  );

  const signOut = useCallback(async () => {
    try {
      await authApi.signOut();
    } catch {
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
