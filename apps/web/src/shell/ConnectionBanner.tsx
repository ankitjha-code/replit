import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { apiRequest, connectivity } from '../lib/api-client.js';
import { useOnline } from '../lib/use-online.js';
import { Banner, Spinner } from '../ui/index.js';

export interface ShellBannerApi {
  setSocketConnected: (connected: boolean | null) => void;
}

const noop: ShellBannerApi = { setSocketConnected: () => {} };
const ShellBannerContext = createContext<ShellBannerApi>(noop);
const SocketStateContext = createContext<boolean | null>(null);

export function useShellBanner(): ShellBannerApi {
  return useContext(ShellBannerContext);
}

export function ShellBannerProvider({ children }: { children: ReactNode }): ReactElement {
  const [socketConnected, setSocketConnected] = useState<boolean | null>(null);
  const api = useMemo<ShellBannerApi>(() => ({ setSocketConnected }), []);
  return (
    <ShellBannerContext.Provider value={api}>
      <SocketStateContext.Provider value={socketConnected}>{children}</SocketStateContext.Provider>
    </ShellBannerContext.Provider>
  );
}

export const RECONNECT_GRACE_MS = 3_000;
const PROBE_MS = 10_000;

export const OFFLINE_MESSAGE =
  'You are offline. Edits are kept in this tab and saved when you reconnect.';
export const RECONNECTING_MESSAGE = 'Reconnecting to the server…';

export function ConnectionBanner(): ReactElement | null {
  const online = useOnline();
  const reachable = useSyncExternalStore(
    connectivity.subscribe,
    connectivity.isReachable,
    () => true,
  );
  const socketConnected = useContext(SocketStateContext);
  const dropped = online && (!reachable || socketConnected === false);

  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    if (!dropped) {
      setReconnecting(false);
      return;
    }
    const timer = setTimeout(() => setReconnecting(true), RECONNECT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [dropped]);

  useEffect(() => {
    if (!online || reachable) return;
    const timer = setInterval(() => {
      void apiRequest('/health/live').catch(() => undefined);
    }, PROBE_MS);
    return () => clearInterval(timer);
  }, [online, reachable]);

  if (!online) {
    return <Banner tone="offline" message={OFFLINE_MESSAGE} className="shell-banner" />;
  }
  if (reconnecting) {
    return (
      <Banner
        tone="warn"
        icon={<Spinner size={16} aria-hidden="true" />}
        message={RECONNECTING_MESSAGE}
        className="shell-banner"
      />
    );
  }
  return null;
}
