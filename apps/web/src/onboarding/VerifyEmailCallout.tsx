import { useState, type ReactElement } from 'react';
import { Button, Callout } from '../ui/index.js';
import { useEmailStepOnChecklist } from './email-step.js';
import { readStorage, writeStorage } from './storage.js';
import { useResendVerification } from './use-resend-verification.js';

export const VERIFY_DISMISSED_KEY = 'ui.verify-dismissed';
const DISMISS_DAYS = 7;

function dismissedRecently(now: number): boolean {
  const stored = readStorage(VERIFY_DISMISSED_KEY);
  if (!stored) return false;
  const at = Date.parse(stored);
  return !Number.isNaN(at) && now - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

export function VerifyEmailCallout(): ReactElement | null {
  const [dismissed, setDismissed] = useState(() => dismissedRecently(Date.now()));
  const resend = useResendVerification();
  const onChecklist = useEmailStepOnChecklist();

  if (dismissed || onChecklist) return null;

  return (
    <Callout
      tone="info"
      className="verify-callout"
      title="Confirm your email so password resets and alerts can reach you."
      action={
        <Button
          size="sm"
          onClick={() => void resend.send()}
          loading={resend.busy}
          {...(resend.cooldown > 0
            ? { disabledReason: `Sent. You can send another in ${resend.cooldown}s.` }
            : {})}
        >
          Resend link
        </Button>
      }
      onDismiss={() => {
        writeStorage(VERIFY_DISMISSED_KEY, new Date().toISOString());
        setDismissed(true);
      }}
    />
  );
}
