import { useEffect, useState } from 'react';
import { Field } from '../../components/Field.js';
import { ApiError } from '../../lib/api-client.js';
import { useAuth } from '../../lib/auth-context.js';
import { useAction } from '../../lib/use-action.js';
import { useResource } from '../../lib/use-resource.js';
import { fetchVerificationStatus, sendVerificationEmail } from '../../lib/verification-api.js';
import { CheckCircle, Envelope } from '../../ui/icons.js';
import {
  Badge,
  Button,
  Callout,
  KeyValue,
  RelativeTime,
  SectionHeader,
  Skeleton,
  toast,
} from '../../ui/index.js';

/**
 * Editing a profile needs `PATCH /api/account`, which the server does not
 * have yet. The fields are shown so the person can see what the platform
 * knows about them, and each says why it cannot be changed.
 */
const PROFILE_EDIT_REASON = 'Profile editing is not available yet';

/** How long after sending a link before another may go: the server's bucket is tighter still. */
const RESEND_COOLDOWN_S = 60;

/** Who you are on this platform, and whether your email address has been proved. */
export function ProfileSection(): React.JSX.Element {
  const { user } = useAuth();
  const verification = useResource((signal) => fetchVerificationStatus(signal), []);

  return (
    <>
      <section className="account-section" aria-labelledby="profile-heading">
        <SectionHeader
          id="profile-heading"
          title="Profile"
          description="Your username is how other people add you to their projects."
        />
        <KeyValue
          loading={!user}
          items={
            user
              ? [
                  { term: 'Username', value: user.username, mono: true },
                  { term: 'Member since', value: <RelativeTime value={user.createdAt} /> },
                ]
              : []
          }
        />
        <div className="account-form">
          <Field
            id="profile-display-name"
            label="Display name"
            value={user?.displayName ?? ''}
            placeholder={user?.username ?? ''}
            hint="Shown instead of your username where there is room."
            disabledReason={PROFILE_EDIT_REASON}
          />
        </div>
      </section>

      <section className="account-section" aria-labelledby="email-heading">
        <SectionHeader
          id="email-heading"
          title="Email"
          description="A confirmed address is what lets a password reset reach you."
        />
        {verification.status === 'loading' ? (
          <Skeleton lines={2} />
        ) : verification.status === 'error' ? (
          <Callout
            tone="danger"
            title={
              verification.error instanceof ApiError
                ? verification.error.message
                : 'Could not read your email status.'
            }
            action={
              <Button size="sm" onClick={verification.reload}>
                Retry
              </Button>
            }
          />
        ) : verification.data ? (
          <EmailStatus
            email={verification.data.email}
            verified={verification.data.verified}
            canSend={verification.data.canSend}
            reason={verification.data.reason}
          />
        ) : null}
      </section>
    </>
  );
}

function EmailStatus({
  email,
  verified,
  canSend,
  reason,
}: {
  email: string;
  verified: boolean;
  canSend: boolean;
  reason: string | null;
}): React.JSX.Element {
  const [cooldown, setCooldown] = useState(0);
  const [sentTo, setSentTo] = useState<string | undefined>();
  const send = useAction(() => sendVerificationEmail());

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const onSend = async (): Promise<void> => {
    const outcome = await send.run();
    if (!outcome.ok) return;
    setSentTo(email);
    setCooldown(RESEND_COOLDOWN_S);
    toast({ tone: 'success', title: 'Confirmation link sent', description: `Sent to ${email}.` });
  };

  return (
    <div className="account-form">
      <Field
        id="profile-email"
        label="Email address"
        value={email}
        disabledReason={PROFILE_EDIT_REASON}
        action={
          verified ? (
            <Badge tone="ok" icon={CheckCircle}>
              Confirmed
            </Badge>
          ) : (
            <Badge tone="warn">Not confirmed</Badge>
          )
        }
      />

      {!verified && !canSend ? (
        <Callout tone="info" title="This installation cannot send email.">
          {reason ?? 'Your address cannot be confirmed here.'}
        </Callout>
      ) : null}

      {!verified && canSend ? (
        <>
          {sentTo ? (
            <Callout tone="ok" title={`A link is on its way to ${sentTo}.`}>
              Open it to confirm your address. It stops working after a while.
            </Callout>
          ) : null}
          {send.error ? (
            <Callout
              tone="danger"
              title={
                send.error instanceof ApiError
                  ? send.error.message
                  : 'The message could not be sent.'
              }
            />
          ) : null}
          <div className="account-form__actions">
            <Button
              icon={Envelope}
              loading={send.busy}
              onClick={() => void onSend()}
              {...(cooldown > 0
                ? { disabledReason: `You can send another link in ${cooldown}s` }
                : {})}
            >
              {sentTo ? 'Send the link again' : 'Send confirmation link'}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
