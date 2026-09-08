import { useCallback, useEffect, useState } from 'react';
import {
  MAX_QUOTA_OVERRIDE,
  QUOTA_LABELS,
  type AccountQuota,
  type OperationsAccount,
  type OperationsHost,
  type OperationsOverview,
  type QuotaKind,
  type SweepReportView,
} from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth-context.js';
import {
  fetchAccountQuotas,
  fetchAuditTrail,
  type AuditEntry,
  fetchAccounts,
  fetchHosts,
  fetchOverview,
  runSweep,
  setAccountQuota,
  setHostDrain,
  setOperator,
} from '../lib/operations-api.js';
import '../styles/projects.css';

/**
 * The installation, seen whole.
 *
 * Everything else in this product is scoped to a project or an account, which
 * is right for the people using it and leaves whoever runs the installation
 * reading logs on the machine to answer "is this healthy".
 *
 * **Nothing on this page is a project's contents.** A project is a number here.
 * That is the boundary between an operator and a backdoor into everybody's
 * work, and the page is built so there is no obvious place to put a file
 * browser: there are no project rows to click.
 */
export function OperationsPage(): React.JSX.Element {
  return (
    <section className="account">
      <header className="account__header">
        <h1>Operations</h1>
      </header>
      <p className="project-section__hint">
        This installation as a whole. Nothing here opens a project: operators see that projects
        exist and what they are consuming, not what is in them.
      </p>

      <OverviewPanel />
      <HostsPanel />
      <SweepPanel />
      <AccountsPanel />
      <AuditPanel />
    </section>
  );
}

function OverviewPanel(): React.JSX.Element {
  const [overview, setOverview] = useState<OperationsOverview | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const controller = new AbortController();

    fetchOverview(controller.signal)
      .then(setOverview)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The overview could not be loaded.');
      });

    return () => controller.abort();
  }, []);

  if (error) return <p className="project-section__error">{error}</p>;
  if (!overview) return <p className="project-section__hint">Loading…</p>;

  return (
    <section className="project-section">
      <div className="project-section__actions">
        <h2>Right now</h2>
      </div>

      <ul className="project-section__list">
        <Count
          label="Accounts"
          value={`${overview.accounts.total}`}
          detail={`${overview.accounts.verified} confirmed · ${overview.accounts.operators} operators`}
        />
        <Count
          label="Projects"
          value={`${overview.projects.total}`}
          detail={`${overview.projects.running} with an environment running`}
        />
        <Count
          label="Deployments"
          value={`${overview.deployments.live}`}
          detail={`${overview.deployments.failed} failed`}
        />
        {/*
         * Failed work is the number worth watching, so it is named rather than
         * left as the third of three. Queued work that is not moving and failed
         * work that nobody saw are the two ways a queue goes quietly wrong.
         */}
        <Count
          label="Background work"
          value={`${overview.jobs.queued} queued`}
          detail={`${overview.jobs.running} running · ${overview.jobs.failed} given up on`}
        />
      </ul>
    </section>
  );
}

function Count({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): React.JSX.Element {
  return (
    <li className="project-section__item">
      <div>
        <p className="project-section__item-name">
          {label}: {value}
        </p>
        <p className="project-section__item-meta">{detail}</p>
      </div>
    </li>
  );
}

/**
 * Each execution host against the capacity somebody declared for it.
 *
 * Declared, not measured. The platform schedules against what an operator said
 * a machine may give it, and showing the machine's own totals would invite
 * filling a host that is also doing something else.
 */
export function HostsPanel(): React.JSX.Element | null {
  const [hosts, setHosts] = useState<OperationsHost[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    fetchHosts(controller.signal)
      .then(setHosts)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (hosts.length === 0) return null;

  return (
    <section className="project-section">
      <div className="project-section__actions">
        <h2>Execution hosts</h2>
      </div>

      {/* Only with more than one: with one there is nowhere else to place work. */}
      {hosts.length > 1 && (
        <p className="project-section__hint">
          Draining a host places nothing new on it. What is already there keeps running and moves to
          another host the next time it is started.
        </p>
      )}

      {error && <p className="project-section__error">{error}</p>}

      <ul className="project-section__list">
        {hosts.map((host) => (
          <li key={host.name} className="project-section__item">
            <div>
              <p className="project-section__item-name">
                {host.name}
                {host.draining && <span className="project-section__item-meta"> draining</span>}
                {!host.draining && !host.schedulable && (
                  <span className="project-section__item-meta"> not accepting work</span>
                )}
              </p>
              <p className="project-section__item-meta">
                {host.workloads.used} of {host.workloads.declared} workloads ·{' '}
                {host.cpuMillicores.used} of {host.cpuMillicores.declared} millicores ·{' '}
                {host.memoryMb.used} of {host.memoryMb.declared} MB
              </p>
              {host.reason && <p className="project-section__error">{host.reason}</p>}
            </div>

            {hosts.length > 1 && (
              <button
                type="button"
                className="button-quiet"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(undefined);
                  setHostDrain(host.name, !host.draining)
                    .then(setHosts)
                    .catch((cause: unknown) =>
                      setError(
                        cause instanceof ApiError ? cause.message : 'That could not be changed.',
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {host.draining ? 'Resume placing work' : 'Drain'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Running a cleanup pass by hand.
 *
 * The dry run is the default and the only thing offered first. A routine that
 * deletes containers is one somebody should watch decide before letting it act,
 * and the button that acts appears only once a report exists to act on.
 */
function SweepPanel(): React.JSX.Element {
  const [report, setReport] = useState<SweepReportView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const sweep = (dryRun: boolean): void => {
    setBusy(true);
    setError(undefined);

    runSweep(dryRun)
      .then(setReport)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : 'The sweep could not be run.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="project-section">
      <div className="project-section__actions">
        <h2>Cleanup</h2>
        <button type="button" className="button-quiet" disabled={busy} onClick={() => sweep(true)}>
          {busy ? 'Looking…' : 'See what would be removed'}
        </button>
        {report?.dryRun && (report.containers.orphaned > 0 || report.objects.orphaned > 0) && (
          <button
            type="button"
            className="button-danger"
            disabled={busy}
            onClick={() => sweep(false)}
          >
            Remove them
          </button>
        )}
      </div>

      <p className="project-section__hint">
        Finds what the platform made and lost track of: containers no record claims, networks whose
        project is gone, databases with no row, and stored files nothing references. Nothing newer
        than the grace period is ever touched.
      </p>

      {error && <p className="project-section__error">{error}</p>}

      {report && (
        <ul className="project-section__list">
          <SweepRow label="Containers" step={report.containers} dryRun={report.dryRun} />
          <SweepRow label="Networks" step={report.networks} dryRun={report.dryRun} />
          <SweepRow label="Project databases" step={report.databases} dryRun={report.dryRun} />
          <SweepRow label="Stored files" step={report.objects} dryRun={report.dryRun} />
          <li className="project-section__item">
            <div>
              <p className="project-section__item-name">Expired sessions and links</p>
              <p className="project-section__item-meta">
                {report.sessions.removed} sessions · {report.tokens.removed} links removed
              </p>
            </div>
          </li>
        </ul>
      )}
    </section>
  );
}

function SweepRow({
  label,
  step,
  dryRun,
}: {
  label: string;
  step: SweepReportView['containers'];
  dryRun: boolean;
}): React.JSX.Element {
  return (
    <li className="project-section__item">
      <div>
        <p className="project-section__item-name">{label}</p>
        <p className="project-section__item-meta">
          {/*
           * A step that was skipped is said so rather than shown as zero.
           * "Found nothing" and "never looked" are different, and only one of
           * them means the installation is clean.
           */}
          {step.skipped
            ? `not checked — ${step.skipped}`
            : `${step.found} found · ${step.orphaned} abandoned · ${
                dryRun ? 'nothing removed' : `${step.removed} removed`
              }${step.failed > 0 ? ` · ${step.failed} could not be removed` : ''}`}
        </p>
      </div>
    </li>
  );
}

function AccountsPanel(): React.JSX.Element {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<OperationsAccount[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [limitsFor, setLimitsFor] = useState<string | undefined>();

  const load = useCallback(async (after?: string, signal?: AbortSignal) => {
    const page = await fetchAccounts(after, signal);
    if (signal?.aborted) return;

    setAccounts((existing) => (after ? [...existing, ...page.accounts] : page.accounts));
    setCursor(page.nextCursor);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(undefined, controller.signal).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof ApiError ? cause.message : 'The accounts could not be loaded.');
    });
    return () => controller.abort();
  }, [load]);

  return (
    <section className="project-section">
      <div className="project-section__actions">
        <h2>Accounts</h2>
      </div>

      {error && <p className="project-section__error">{error}</p>}

      <ul className="project-section__list">
        {accounts.map((account) => (
          <li key={account.id} className="project-section__item">
            <div>
              <p className="project-section__item-name">
                {account.username}
                {account.isOperator && (
                  <span className="project-section__item-meta"> operator</span>
                )}
              </p>
              <p className="project-section__item-meta">
                {account.email}
                {account.emailVerified ? '' : ' (unconfirmed)'} · {account.projects} projects
              </p>
            </div>

            {/*
             * No control on your own row.
             *
             * Removing your own operator access is one click and, on an
             * installation with one operator, unrecoverable without the
             * machine. The server refuses it too; this is so the button that
             * would be refused is not there to press.
             */}
            {account.id !== user?.id && (
              <button
                type="button"
                className="button-quiet"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(undefined);

                  setOperator(account.id, !account.isOperator)
                    .then(() => load())
                    .catch((cause: unknown) => {
                      setError(
                        cause instanceof ApiError ? cause.message : 'That could not be changed.',
                      );
                    })
                    .finally(() => setBusy(false));
                }}
              >
                {account.isOperator ? 'Remove operator' : 'Make operator'}
              </button>
            )}

            <button
              type="button"
              className="button-quiet"
              aria-expanded={limitsFor === account.id}
              onClick={() => setLimitsFor((open) => (open === account.id ? undefined : account.id))}
            >
              Limits
            </button>

            {limitsFor === account.id && <AccountLimits accountId={account.id} />}
          </li>
        ))}
      </ul>

      {cursor && (
        <button
          type="button"
          className="button-quiet"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            load(cursor)
              .catch(() => setError('The next page could not be loaded.'))
              .finally(() => setBusy(false));
          }}
        >
          Show more
        </button>
      )}
    </section>
  );
}

/**
 * One account's ceilings, editable.
 *
 * Each row shows the default beside the effective limit, so an exception is
 * never mistaken for the rule, and "Use default" removes the exception rather
 * than writing the default in as one — which would stop tracking the default
 * if the installation's setting changed later.
 */
export function AccountLimits({ accountId }: { accountId: string }): React.JSX.Element {
  const [quotas, setQuotas] = useState<AccountQuota[] | undefined>();
  const [drafts, setDrafts] = useState<Partial<Record<QuotaKind, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    fetchAccountQuotas(accountId, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setQuotas(loaded);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The limits could not be loaded.');
      });
    return () => controller.abort();
  }, [accountId]);

  const save = (kind: QuotaKind, limit: number | null): void => {
    setBusy(true);
    setError(undefined);
    setAccountQuota(accountId, kind, limit)
      .then((updated) => {
        setQuotas(updated);
        setDrafts((existing) => ({ ...existing, [kind]: undefined }));
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : 'That limit could not be changed.');
      })
      .finally(() => setBusy(false));
  };

  if (!quotas) {
    return error ? (
      <p className="project-section__error">{error}</p>
    ) : (
      <p className="project-section__note">Loading limits…</p>
    );
  }

  return (
    <div className="project-section__item-value">
      {error && <p className="project-section__error">{error}</p>}
      {quotas.map((quota) => {
        const inputId = `limit-${accountId}-${quota.kind}`;
        const draft = drafts[quota.kind] ?? String(quota.limit);
        return (
          <form
            key={quota.kind}
            className="project-section__form"
            onSubmit={(event) => {
              event.preventDefault();
              save(quota.kind, Number(draft));
            }}
          >
            <label htmlFor={inputId}>{QUOTA_LABELS[quota.kind]}</label>
            <input
              id={inputId}
              type="number"
              min={1}
              max={MAX_QUOTA_OVERRIDE}
              value={draft}
              onChange={(event) =>
                setDrafts((existing) => ({ ...existing, [quota.kind]: event.target.value }))
              }
            />
            <span className="project-section__item-meta">
              using {quota.used} ·{' '}
              {quota.overridden ? `default is ${quota.defaultLimit}` : 'the default'}
            </span>
            <button type="submit" className="button-quiet" disabled={busy}>
              Set
            </button>
            {quota.overridden && (
              <button
                type="button"
                className="button-quiet"
                disabled={busy}
                onClick={() => save(quota.kind, null)}
              >
                Use default
              </button>
            )}
          </form>
        );
      })}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'host.drain': 'drained a host',
  'host.undrain': 'resumed placing work on a host',
  'quota.override': 'changed the limits of',
  'quota.reset': 'put back on the default limits',
  'operator.grant': 'made an operator',
  'operator.revoke': 'removed as an operator',
  'sweep.run': 'ran a cleanup sweep',
};

/**
 * What operators have done.
 *
 * Read-only, and there is no way to remove an entry from here or anywhere else:
 * a trail the people it records could tidy would not be a trail.
 */
function AuditPanel(): React.JSX.Element | null {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetchAuditTrail(controller.signal)
      .then(setEntries)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (entries.length === 0) return null;

  return (
    <section className="project-section">
      <div className="project-section__actions">
        <h2>What operators have done</h2>
      </div>
      <ul className="project-section__list">
        {entries.map((entry) => (
          <li key={entry.id} className="project-section__item">
            <div>
              <p className="project-section__item-name">
                {entry.actor} {entry.target ? `— ${entry.target} ` : ''}
                {ACTION_LABELS[entry.action] ?? entry.action}
              </p>
              <p className="project-section__item-meta">{new Date(entry.at).toLocaleString()}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
