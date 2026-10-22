import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom';
import { Button } from '../ui/Button/Button.js';
import { Callout } from '../ui/Callout/Callout.js';
import { Dialog } from '../ui/Dialog/Dialog.js';

/**
 * Asks before the app navigates away from unsaved work.
 *
 * Anything that holds work registers a guard; anything that navigates asks
 * `confirmLeave()` first. The editor registers its open files, and the
 * breadcrumb, the account menu, Sign out, the palette and the phone switcher
 * all ask. Held as a context rather than a router blocker because the unit
 * harnesses render in a MemoryRouter or with no router at all, where
 * `useBlocker` throws. `beforeunload` for a hard navigation stays with the
 * code that owns the buffers.
 */

export interface NavigationGuard {
  isDirty: () => boolean;
  /** Saves everything the guard holds. Rejects when a save fails, which keeps the dialog open. */
  flush: () => Promise<void>;
  /** One short line for the dialog, such as "2 files with unsaved changes". */
  describe?: () => string;
}

export type LeaveDecision = 'proceed' | 'stay';

export interface NavigationGuardApi {
  /** Returns the function that removes the guard again. */
  registerGuard: (id: string, guard: NavigationGuard) => () => void;
  hasDirty: () => boolean;
  /** Resolves at once with 'proceed' when nothing is dirty; otherwise asks. */
  confirmLeave: () => Promise<LeaveDecision>;
}

/**
 * Permissive by default so a screen rendered without the provider, as the
 * unit harnesses do, registers nothing and is never blocked.
 */
const PERMISSIVE: NavigationGuardApi = {
  registerGuard: () => () => {},
  hasDirty: () => false,
  confirmLeave: () => Promise.resolve('proceed'),
};

const NavigationGuardContext = createContext<NavigationGuardApi>(PERMISSIVE);

export function useNavigationGuard(): NavigationGuardApi {
  return useContext(NavigationGuardContext);
}

/** Registers a guard for the life of the component, reading the latest callbacks. */
export function useRegisterGuard(id: string, guard: NavigationGuard): void {
  const { registerGuard } = useNavigationGuard();
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(
    () =>
      registerGuard(id, {
        isDirty: () => latest.current.isDirty(),
        flush: () => latest.current.flush(),
        describe: () => latest.current.describe?.() ?? '',
      }),
    [id, registerGuard],
  );
}

/** `navigate` that asks first. Resolves after the navigation, or without one when the person stays. */
export function useGuardedNavigate(): (
  to: To | number,
  options?: NavigateOptions,
) => Promise<void> {
  const navigate = useNavigate();
  const { confirmLeave } = useNavigationGuard();
  return useCallback(
    async (to, options) => {
      if ((await confirmLeave()) !== 'proceed') return;
      if (typeof to === 'number') void navigate(to);
      else void navigate(to, options);
    },
    [confirmLeave, navigate],
  );
}

interface Pending {
  resolve: (decision: LeaveDecision) => void;
  promise: Promise<LeaveDecision>;
}

export function NavigationGuardProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const guards = useRef(new Map<string, NavigationGuard>());
  const pending = useRef<Pending | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [summary, setSummary] = useState<string[]>([]);

  const dirtyGuards = useCallback(
    () => [...guards.current.values()].filter((guard) => guard.isDirty()),
    [],
  );

  const settle = useCallback((decision: LeaveDecision) => {
    const current = pending.current;
    pending.current = undefined;
    setOpen(false);
    setSaving(false);
    setSaveError(undefined);
    current?.resolve(decision);
  }, []);

  const api = useMemo<NavigationGuardApi>(
    () => ({
      registerGuard: (id, guard) => {
        guards.current.set(id, guard);
        return () => {
          if (guards.current.get(id) === guard) guards.current.delete(id);
        };
      },
      hasDirty: () => dirtyGuards().length > 0,
      confirmLeave: () => {
        // A second caller while the question is open shares the same answer.
        if (pending.current) return pending.current.promise;
        const dirty = dirtyGuards();
        if (dirty.length === 0) return Promise.resolve('proceed');
        let resolve!: (decision: LeaveDecision) => void;
        const promise = new Promise<LeaveDecision>((res) => {
          resolve = res;
        });
        pending.current = { resolve, promise };
        setSummary(dirty.map((guard) => guard.describe?.() ?? '').filter((line) => line !== ''));
        setSaveError(undefined);
        setOpen(true);
        return promise;
      },
    }),
    [dirtyGuards],
  );

  const saveAndLeave = async (): Promise<void> => {
    setSaving(true);
    setSaveError(undefined);
    try {
      await Promise.all(dirtyGuards().map((guard) => guard.flush()));
      settle('proceed');
    } catch (cause) {
      setSaving(false);
      setSaveError(cause instanceof Error ? cause.message : 'Some changes could not be saved.');
    }
  };

  return (
    <NavigationGuardContext.Provider value={api}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !saving) settle('stay');
        }}
        title="You have unsaved changes"
        description="Save them before leaving, or leave and lose them."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => settle('stay')} disabled={saving}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => settle('proceed')} disabled={saving}>
              Leave without saving
            </Button>
            <Button variant="primary" onClick={() => void saveAndLeave()} loading={saving}>
              Save and leave
            </Button>
          </>
        }
      >
        {summary.length > 0 && (
          <ul className="navigation-guard__summary">
            {summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {saveError && (
          <Callout tone="danger" title="Not saved">
            {saveError}
          </Callout>
        )}
      </Dialog>
    </NavigationGuardContext.Provider>
  );
}
