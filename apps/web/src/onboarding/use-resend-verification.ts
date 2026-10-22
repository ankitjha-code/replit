import { useCallback, useEffect, useState } from 'react';
import { sendVerificationEmail } from '../lib/verification-api.js';
import { useAction } from '../lib/use-action.js';
import { toast } from '../ui/index.js';

export const RESEND_COOLDOWN_SECONDS = 60;

let lastSentAt = 0;
const listeners = new Set<() => void>();

function secondsLeft(now: number): number {
  return Math.max(0, Math.ceil((lastSentAt + RESEND_COOLDOWN_SECONDS * 1000 - now) / 1000));
}

export function resetResendCooldown(): void {
  lastSentAt = 0;
  for (const listener of listeners) listener();
}

export interface ResendVerification {
  send: () => Promise<void>;
  busy: boolean;
  cooldown: number;
}

export function useResendVerification(): ResendVerification {
  const [cooldown, setCooldown] = useState(() => secondsLeft(Date.now()));
  const action = useAction(sendVerificationEmail);

  useEffect(() => {
    const sync = (): void => setCooldown(secondsLeft(Date.now()));
    listeners.add(sync);
    const timer = setInterval(sync, 1000);
    return () => {
      listeners.delete(sync);
      clearInterval(timer);
    };
  }, []);

  const send = useCallback(async () => {
    if (secondsLeft(Date.now()) > 0) return;
    const outcome = await action.run();
    if (outcome.ok) {
      lastSentAt = Date.now();
      for (const listener of listeners) listener();
      toast({ tone: 'success', title: 'Link sent. Check your inbox.' });
    } else {
      toast({
        tone: 'danger',
        title: 'Could not send the link.',
        description: outcome.error.message,
      });
    }
  }, [action]);

  return { send, busy: action.busy, cooldown };
}
