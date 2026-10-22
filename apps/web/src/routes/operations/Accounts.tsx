import { useState } from 'react';
import type { OperationsAccount } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { useAuth } from '../../lib/auth-context.js';
import { fetchAccounts, setOperator } from '../../lib/operations-api.js';
import { useAction } from '../../lib/use-action.js';
import { useResource } from '../../lib/use-resource.js';
import { MagnifyingGlass, ShieldCheck, SlidersHorizontal, Users } from '../../ui/icons.js';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  ListRow,
  RelativeTime,
  SectionHeader,
  Skeleton,
  toast,
} from '../../ui/index.js';
import { AccountLimits } from './AccountLimits.js';

interface Page {
  accounts: OperationsAccount[];
  nextCursor: string | null;
}

/**
 * Every account on the installation, with the two things an operator can do
 * to one: make it an operator too, and change its limits.
 *
 * No operator control on your own row. Removing your own operator access is
 * one click and, on an installation with one operator, unrecoverable without
 * the machine. The server refuses it too; this is so the button that would
 * be refused is not there to press.
 */
export function Accounts(): React.JSX.Element {
  const { user } = useAuth();
  const first = useResource((signal) => fetchAccounts(undefined, signal), []);
  // Later pages hang off the first one, so a reload of the first page (after
  // an operator change) replaces the whole list instead of appending to it.
  const [more, setMore] = useState<{ base: Page | undefined; pages: Page[] } | undefined>();
  const extra = more && more.base === first.data ? more.pages : [];
  const accounts = [...(first.data?.accounts ?? []), ...extra.flatMap((page) => page.accounts)];
  const cursor = extra.length
    ? extra[extra.length - 1]!.nextCursor
    : (first.data?.nextCursor ?? null);
  const loadMore = useAction(async () => {
    if (!cursor) return;
    const page = await fetchAccounts(cursor);
    setMore({ base: first.data, pages: [...extra, page] });
  });

  const [query, setQuery] = useState('');
  const [limitsFor, setLimitsFor] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<OperationsAccount | undefined>();

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? accounts.filter(
        (account) =>
          account.username.toLowerCase().includes(needle) ||
          account.email.toLowerCase().includes(needle),
      )
    : accounts;

  const errorMessage =
    first.status === 'error'
      ? first.error instanceof ApiError
        ? first.error.message
        : 'The accounts could not be loaded.'
      : undefined;
  const moreError = loadMore.error
    ? loadMore.error instanceof ApiError
      ? loadMore.error.message
      : 'The next page could not be loaded.'
    : undefined;

  return (
    <section className="operations-section" aria-labelledby="accounts-heading">
      <SectionHeader
        id="accounts-heading"
        title="Accounts"
        description="Who has an account here, who operates the installation, and what each may run."
        {...(first.data ? { count: accounts.length } : {})}
        action={
          <Input
            type="search"
            size="md"
            aria-label="Search accounts"
            placeholder="Search by name or email"
            leading={<MagnifyingGlass size={16} aria-hidden="true" />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="accounts__search"
          />
        }
      />

      {cursor && needle ? (
        <p className="accounts__note">
          Searching the {accounts.length} accounts loaded so far. Show more to search further.
        </p>
      ) : null}

      {errorMessage ? (
        <Callout
          tone="danger"
          title={errorMessage}
          action={
            <Button size="sm" onClick={first.reload}>
              Retry
            </Button>
          }
        />
      ) : first.status === 'loading' ? (
        <div className="accounts__skeleton" aria-busy="true">
          <Skeleton shape="row" />
          <Skeleton shape="row" />
          <Skeleton shape="row" />
        </div>
      ) : shown.length === 0 ? (
        needle ? (
          <EmptyState
            icon={MagnifyingGlass}
            title="No accounts match."
            body="Try part of a username or an email address."
            action={<Button onClick={() => setQuery('')}>Clear search</Button>}
          />
        ) : (
          <EmptyState
            icon={Users}
            title="No accounts yet."
            body="Accounts appear here as people sign up."
          />
        )
      ) : (
        <ul className="accounts__list" aria-label="Accounts">
          {shown.map((account) => {
            const own = account.id === user?.id;
            const limitsOpen = limitsFor === account.id;
            const limitsId = `limits-${account.id}`;
            return (
              <ListRow
                key={account.id}
                metaFirst
                title={account.username}
                badge={account.isOperator ? <Badge tone="info">Operator</Badge> : null}
                description={
                  <span className="accounts__email">
                    <span>{account.email}</span>
                    {account.emailVerified ? null : <Badge tone="warn">Not confirmed</Badge>}
                  </span>
                }
                meta={
                  <span className="accounts__meta">
                    <span>
                      {account.projects} {account.projects === 1 ? 'project' : 'projects'}
                    </span>
                    <RelativeTime value={account.createdAt} prefix="Joined" />
                  </span>
                }
                actions={
                  <span className="accounts__actions">
                    <IconButton
                      size="sm"
                      icon={SlidersHorizontal}
                      label={`Edit limits for ${account.username}`}
                      aria-expanded={limitsOpen}
                      aria-controls={limitsOpen ? limitsId : undefined}
                      onClick={() => setLimitsFor(limitsOpen ? undefined : account.id)}
                    />
                    <IconButton
                      size="sm"
                      icon={ShieldCheck}
                      label={
                        account.isOperator
                          ? `Remove operator from ${account.username}`
                          : `Make ${account.username} an operator`
                      }
                      className={account.isOperator ? 'accounts__revoke' : undefined}
                      onClick={() => setConfirming(account)}
                      {...(own
                        ? { disabledReason: 'You cannot change your own operator access' }
                        : {})}
                    />
                  </span>
                }
                expanded={
                  limitsOpen ? (
                    <div id={limitsId}>
                      <AccountLimits accountId={account.id} />
                    </div>
                  ) : null
                }
              />
            );
          })}
        </ul>
      )}

      {first.data && !needle ? (
        <div className="accounts__footer">
          <span className="accounts__count">{accounts.length} shown</span>
          {cursor ? (
            <Button size="sm" loading={loadMore.busy} onClick={() => void loadMore.run()}>
              Show more
            </Button>
          ) : null}
        </div>
      ) : null}
      {moreError ? (
        <Callout
          tone="danger"
          title={moreError}
          action={
            <Button size="sm" onClick={() => void loadMore.run()}>
              Retry
            </Button>
          }
        />
      ) : null}

      <ConfirmDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        tone={confirming?.isOperator ? 'danger' : 'default'}
        title={
          confirming
            ? confirming.isOperator
              ? `Remove operator access from ${confirming.username}?`
              : `Make ${confirming.username} an operator?`
            : ''
        }
        body={
          confirming?.isOperator
            ? 'They keep their account and projects, and lose this Operations area.'
            : 'They will see this Operations area: every account, host and limit on the installation. Operators never see what is inside a project.'
        }
        confirmLabel={
          confirming?.isOperator
            ? `Remove operator from ${confirming.username}`
            : `Make ${confirming?.username ?? 'account'} an operator`
        }
        onConfirm={async () => {
          if (!confirming) return;
          await setOperator(confirming.id, !confirming.isOperator);
          first.reload();
          toast({
            tone: 'success',
            title: confirming.isOperator
              ? `${confirming.username} is no longer an operator`
              : `${confirming.username} is now an operator`,
          });
        }}
      />
    </section>
  );
}
