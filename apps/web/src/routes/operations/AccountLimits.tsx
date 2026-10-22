import { useId, useState } from 'react';
import {
  MAX_QUOTA_OVERRIDE,
  QUOTA_LABELS,
  type AccountQuota,
  type QuotaKind,
} from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { fetchAccountQuotas, setAccountQuota } from '../../lib/operations-api.js';
import { useAction } from '../../lib/use-action.js';
import { useResource } from '../../lib/use-resource.js';
import { Badge, Button, Callout, Input, Skeleton, toast } from '../../ui/index.js';
import { usePatched } from './use-patched.js';

export function AccountLimits({ accountId }: { accountId: string }): React.JSX.Element {
  const list = useResource((signal) => fetchAccountQuotas(accountId, signal), [accountId]);
  const [quotas, setQuotas] = usePatched(list.data);
  const [drafts, setDrafts] = useState<Partial<Record<QuotaKind, string>>>({});
  const [invalid, setInvalid] = useState<QuotaKind | undefined>();
  const [pending, setPending] = useState<QuotaKind | undefined>();
  const save = useAction(async (kind: QuotaKind, limit: number | null) => {
    setPending(kind);
    try {
      setQuotas(await setAccountQuota(accountId, kind, limit));
    } finally {
      setPending(undefined);
    }
    setDrafts((existing) => ({ ...existing, [kind]: undefined }));
    toast({
      tone: 'success',
      title:
        limit === null
          ? `${QUOTA_LABELS[kind]} is back on the default`
          : `${QUOTA_LABELS[kind]} set to ${limit}`,
    });
  });
  const headingId = useId();

  if (list.status === 'loading' || (!quotas && list.status !== 'error')) {
    return (
      <div className="limits" aria-busy="true">
        <Skeleton lines={3} />
      </div>
    );
  }

  if (!quotas) {
    return (
      <Callout
        tone="danger"
        title={
          list.error instanceof ApiError ? list.error.message : 'The limits could not be loaded.'
        }
        action={
          <Button size="sm" onClick={list.reload}>
            Retry
          </Button>
        }
      />
    );
  }

  const saveError = save.error
    ? save.error instanceof ApiError
      ? save.error.message
      : 'That limit could not be changed.'
    : undefined;

  return (
    <div className="limits" aria-labelledby={headingId} role="group">
      <p id={headingId} className="limits__heading">
        Limits
      </p>
      {saveError ? <Callout tone="danger" title={saveError} /> : null}
      {quotas.map((quota) => (
        <LimitRow
          key={quota.kind}
          accountId={accountId}
          quota={quota}
          draft={drafts[quota.kind]}
          invalid={invalid === quota.kind}
          busy={pending === quota.kind}
          onDraft={(value) => {
            setInvalid(undefined);
            setDrafts((existing) => ({ ...existing, [quota.kind]: value }));
          }}
          onSet={(value) => {
            const limit = parseLimit(value);
            if (limit === undefined) {
              setInvalid(quota.kind);
              return;
            }
            void save.run(quota.kind, limit);
          }}
          onUseDefault={() => void save.run(quota.kind, null)}
        />
      ))}
    </div>
  );
}

export function parseLimit(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUOTA_OVERRIDE) return undefined;
  return limit;
}

function LimitRow({
  accountId,
  quota,
  draft,
  invalid,
  busy,
  onDraft,
  onSet,
  onUseDefault,
}: {
  accountId: string;
  quota: AccountQuota;
  draft: string | undefined;
  invalid: boolean;
  busy: boolean;
  onDraft: (value: string) => void;
  onSet: (value: string) => void;
  onUseDefault: () => void;
}): React.JSX.Element {
  const inputId = `limit-${accountId}-${quota.kind}`;
  const hintId = `${inputId}-hint`;
  const value = draft ?? String(quota.limit);
  const unchanged = value === String(quota.limit);
  const atLimit = quota.used >= quota.limit;

  return (
    <form
      className="limits__row"
      onSubmit={(event) => {
        event.preventDefault();
        onSet(value);
      }}
    >
      <label htmlFor={inputId} className="limits__label">
        {QUOTA_LABELS[quota.kind]}
      </label>
      <div className="limits__control">
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_QUOTA_OVERRIDE}
          size="md"
          value={value}
          invalid={invalid}
          aria-describedby={hintId}
          onChange={(event) => onDraft(event.target.value)}
          className="limits__input"
        />
        <Button
          type="submit"
          size="md"
          loading={busy}
          {...(unchanged ? { disabledReason: 'Nothing changed' } : {})}
        >
          Set
        </Button>
        {quota.overridden ? (
          <Button type="button" size="md" variant="ghost" loading={busy} onClick={onUseDefault}>
            Use default
          </Button>
        ) : null}
      </div>
      <p id={hintId} className={invalid ? 'limits__hint limits__hint--invalid' : 'limits__hint'}>
        {invalid ? (
          <span role="alert">Enter a whole number from 1 to {MAX_QUOTA_OVERRIDE}.</span>
        ) : (
          <>
            Using {quota.used}
            {quota.overridden ? `, default is ${quota.defaultLimit}` : ' (default)'}
            {atLimit ? (
              <>
                {' '}
                <Badge tone="warn">At limit</Badge>
              </>
            ) : null}
          </>
        )}
      </p>
    </form>
  );
}
