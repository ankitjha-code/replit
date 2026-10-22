import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { PASSWORD_MIN_LENGTH, type TwoFactorStatus } from '@platform/shared';
import { Field } from '../../components/Field.js';
import {
  beginTwoFactor,
  changePassword,
  confirmTwoFactor,
  disableTwoFactor,
  fetchTwoFactorStatus,
} from '../../lib/account-api.js';
import { ApiError } from '../../lib/api-client.js';
import { fieldErrorsFrom, type FieldErrors } from '../../lib/form-errors.js';
import { useAction } from '../../lib/use-action.js';
import { useResource } from '../../lib/use-resource.js';
import { DownloadSimple, Key, ShieldCheck } from '../../ui/icons.js';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  CodeBlock,
  Dialog,
  SectionHeader,
  Skeleton,
  toast,
} from '../../ui/index.js';

export function SecuritySection(): React.JSX.Element {
  return (
    <>
      <section className="account-section" aria-labelledby="password-heading">
        <SectionHeader
          id="password-heading"
          title="Password"
          description="Changing it is the fix when you think somebody else knows it."
        />
        <PasswordForm />
      </section>

      <section className="account-section" aria-labelledby="two-factor-heading">
        <SectionHeader
          id="two-factor-heading"
          title="Two-factor sign-in"
          description="With this on, your password alone cannot sign in: a code from an authenticator app is needed too."
        />
        <TwoFactorCard />
      </section>
    </>
  );
}

function PasswordForm(): React.JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const change = useAction(() => changePassword({ currentPassword, newPassword, signOutOthers }));

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFieldErrors({});
    const outcome = await change.run();
    if (!outcome.ok) {
      setFieldErrors(fieldErrorsFrom(outcome.error).fields);
      return;
    }
    setCurrentPassword('');
    setNewPassword('');
    const signedOut = outcome.value;
    toast({
      tone: 'success',
      title: 'Password changed',
      ...(signedOut > 0
        ? {
            description:
              signedOut === 1
                ? 'One other session was signed out.'
                : `${signedOut} other sessions were signed out.`,
          }
        : {}),
    });
  };

  const formError =
    change.error && Object.keys(fieldErrors).length === 0
      ? change.error instanceof ApiError
        ? (fieldErrorsFrom(change.error).message ?? change.error.message)
        : 'The password could not be changed.'
      : undefined;

  return (
    <form className="account-form" onSubmit={(event) => void onSubmit(event)} noValidate>
      <Field
        id="current-password"
        label="Current password"
        as="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(event) => {
          setCurrentPassword(event.target.value);
          if (change.error) change.reset();
        }}
        error={fieldErrors.currentPassword}
        required
      />
      <Field
        id="new-password"
        label="New password"
        as="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(event) => {
          setNewPassword(event.target.value);
          if (change.error) change.reset();
        }}
        error={fieldErrors.newPassword}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        required
      />
      <Checkbox
        label="Sign out everywhere else"
        description="Every other browser and device is signed out."
        checked={signOutOthers}
        onCheckedChange={(checked) => setSignOutOthers(checked)}
      />
      {formError ? <Callout tone="danger" title={formError} /> : null}
      <div className="account-form__actions">
        <Button
          type="submit"
          variant="primary"
          icon={Key}
          loading={change.busy}
          {...(currentPassword === '' || newPassword === ''
            ? { disabledReason: 'Enter your current password and a new one' }
            : {})}
        >
          Change password
        </Button>
      </div>
    </form>
  );
}

function TwoFactorCard(): React.JSX.Element {
  const status = useResource((signal) => fetchTwoFactorStatus(signal), []);
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  if (status.status === 'loading') {
    return (
      <Card className="account-card" aria-busy="true">
        <Skeleton lines={2} />
      </Card>
    );
  }
  if (status.status === 'error' || !status.data) {
    return (
      <Callout
        tone="danger"
        title={
          status.error instanceof ApiError
            ? status.error.message
            : 'Could not read your two-factor settings.'
        }
        action={
          <Button size="sm" onClick={status.reload}>
            Retry
          </Button>
        }
      />
    );
  }

  const current: TwoFactorStatus = status.data;
  if (!current.available) {
    return (
      <Callout tone="info" title="Two-factor sign-in is not available on this installation.">
        It needs an encryption key the installation does not have, so a second factor cannot be
        stored here.
      </Callout>
    );
  }

  return (
    <Card className="account-card">
      <div className="account-card__row">
        <h3 className="account-card__title">
          <ShieldCheck size={16} aria-hidden="true" />
          Authenticator app
          {current.enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
        </h3>
        {current.enabled ? (
          <Button variant="danger" onClick={() => setDisableOpen(true)}>
            Disable
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setSetupOpen(true)}>
            Turn on
          </Button>
        )}
      </div>
      {current.enabled ? (
        <>
          <p className="account-card__text">
            {current.recoveryCodesLeft === 1
              ? 'One recovery code left.'
              : `${current.recoveryCodesLeft} recovery codes left.`}{' '}
            Each works once, instead of a code from your app, if you lose your phone.
          </p>
          <div className="account-card__actions">
            <Button disabledReason="Regenerating recovery codes is not available yet. Turn two-factor off and on again to get new ones.">
              New recovery codes
            </Button>
          </div>
        </>
      ) : (
        <p className="account-card__text">
          You will need an authenticator app such as Aegis, 1Password or Google Authenticator.
        </p>
      )}

      <TwoFactorSetupDialog
        open={setupOpen}
        onClose={() => {
          setSetupOpen(false);
          status.reload();
        }}
      />
      <TwoFactorDisableDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        recoveryCodesLeft={current.recoveryCodesLeft}
        onDisabled={() => {
          setDisableOpen(false);
          status.reload();
          toast({ tone: 'success', title: 'Two-factor sign-in is off' });
        }}
      />
    </Card>
  );
}

interface Setup {
  secret: string;
  uri: string;
  qr: string;
}

function TwoFactorSetupDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [setup, setSetup] = useState<Setup | undefined>();
  const [setupError, setSetupError] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [saved, setSaved] = useState(false);
  const begin = useAction(async (): Promise<Setup> => {
    const started = await beginTwoFactor();
    const qr = await QRCode.toDataURL(started.uri, { margin: 1, width: 320 });
    return { ...started, qr };
  });
  const confirm = useAction(() => confirmTwoFactor(code.trim()));

  useEffect(() => {
    if (!open) {
      setSetup(undefined);
      setSetupError(undefined);
      setCode('');
      setCodeError(undefined);
      setRecoveryCodes(undefined);
      setSaved(false);
      return;
    }
    let cancelled = false;
    void begin.run().then((outcome) => {
      if (cancelled) return;
      if (outcome.ok) setSetup(outcome.value);
      else
        setSetupError(
          outcome.error instanceof ApiError
            ? outcome.error.message
            : 'A second factor could not be started.',
        );
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const digits = code.trim();
  const codeReady = /^\d{6}$/.test(digits);

  const onConfirm = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!codeReady) {
      setCodeError('Enter the six digits your app shows');
      return;
    }
    setCodeError(undefined);
    const outcome = await confirm.run();
    if (outcome.ok) {
      setRecoveryCodes(outcome.value);
      toast({ tone: 'success', title: 'Two-factor sign-in is on' });
      return;
    }
    setCodeError(
      outcome.error instanceof ApiError
        ? (fieldErrorsFrom(outcome.error).fields.code ?? outcome.error.message)
        : 'That code could not be checked.',
    );
  };

  const showingCodes = recoveryCodes !== undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && showingCodes && !saved) return;
        if (!next) onClose();
      }}
      title={showingCodes ? 'Save your recovery codes' : 'Turn on two-factor sign-in'}
      size="md"
      loading={!setup && !setupError && !showingCodes}
      {...(setupError && !showingCodes ? { error: setupError } : {})}
      footer={
        showingCodes ? (
          <Button
            variant="primary"
            onClick={onClose}
            {...(saved ? {} : { disabledReason: 'Confirm you have saved the codes first' })}
          >
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="two-factor-confirm"
              variant="primary"
              loading={confirm.busy}
              {...(setup ? {} : { disabledReason: 'Waiting for the setup key' })}
            >
              Turn it on
            </Button>
          </>
        )
      }
    >
      {showingCodes ? (
        <div className="recovery-codes">
          <Callout tone="warn" title="These will not be shown again.">
            Each code works once, instead of a code from your app, if you lose your phone. Store
            them somewhere safe.
          </Callout>
          <CodeBlock code={recoveryCodes.join('\n')} label="Recovery codes" copy />
          <div className="recovery-codes__actions">
            <Button
              icon={DownloadSimple}
              onClick={() => downloadText('recovery-codes.txt', recoveryCodes.join('\n'))}
            >
              Download
            </Button>
          </div>
          <Checkbox
            label="I have saved these codes"
            checked={saved}
            onCheckedChange={(checked) => setSaved(checked)}
          />
        </div>
      ) : setup ? (
        <form
          id="two-factor-confirm"
          className="two-factor-setup"
          onSubmit={(event) => void onConfirm(event)}
          noValidate
        >
          <div className="two-factor-setup__scan">
            <img
              className="two-factor-setup__qr"
              src={setup.qr}
              alt="A QR code for your authenticator app"
              width={160}
              height={160}
            />
            <div className="two-factor-setup__key">
              <p className="two-factor-setup__text">
                Scan this with your authenticator app, or type the key in by hand.
              </p>
              <CodeBlock code={setup.secret} label="Setup key" copy wrap />
            </div>
          </div>
          <Field
            id="two-factor-code"
            label="Code from the app"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              if (codeError) setCodeError(undefined);
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            maxLength={6}
            mono
            error={codeError}
            hint="Six digits. It changes every 30 seconds."
            autoFocus
          />
        </form>
      ) : null}
    </Dialog>
  );
}

function TwoFactorDisableDialog({
  open,
  onOpenChange,
  recoveryCodesLeft,
  onDisabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recoveryCodesLeft: number;
  onDisabled: () => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const disable = useAction(() => disableTwoFactor(password, code.trim()));

  useEffect(() => {
    if (!open) {
      setPassword('');
      setCode('');
      disable.reset();
    }
  }, [open]);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const outcome = await disable.run();
    if (outcome.ok) onDisabled();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Disable two-factor sign-in?"
      description="Your password alone will sign in again. This needs your password and a current code."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="two-factor-disable"
            variant="danger"
            loading={disable.busy}
            {...(password === '' || code.trim() === ''
              ? { disabledReason: 'Enter your password and a code' }
              : {})}
          >
            Disable two-factor sign-in
          </Button>
        </>
      }
    >
      <form
        id="two-factor-disable"
        className="account-form"
        onSubmit={(event) => void onSubmit(event)}
        noValidate
      >
        <Field
          id="two-factor-disable-password"
          label="Password"
          as="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (disable.error) disable.reset();
          }}
          required
          autoFocus
        />
        <Field
          id="two-factor-disable-code"
          label="Code from the app, or a recovery code"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            if (disable.error) disable.reset();
          }}
          autoComplete="one-time-code"
          mono
          {...(recoveryCodesLeft > 0
            ? { hint: `A recovery code works here too. You have ${recoveryCodesLeft} left.` }
            : {})}
          required
        />
        {disable.error ? (
          <Callout
            tone="danger"
            title={
              disable.error instanceof ApiError
                ? disable.error.message
                : 'It could not be turned off.'
            }
          />
        ) : null}
      </form>
    </Dialog>
  );
}

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
