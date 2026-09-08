import { useEffect, useState } from 'react';
import { QUOTA_LABELS, isQuotaFull, type QuotaUsage } from '@platform/shared';
import { fetchQuotas } from '../lib/quotas-api.js';

/**
 * How much of the platform this account is using at once.
 *
 * On the project list rather than inside a project, because it is not about one:
 * the ceiling is per account, and somebody wondering why Start was refused is
 * looking at the wrong project by definition — the one that is full is one of
 * the others.
 *
 * Shown only when something is actually being used. An account with nothing
 * running does not need to be told about a limit it is nowhere near, and a row
 * of zeroes on the first page somebody sees would be the platform talking about
 * itself rather than about their work.
 */
export function AccountUsage(): React.JSX.Element | null {
  const [quotas, setQuotas] = useState<QuotaUsage[]>([]);

  useEffect(() => {
    const controller = new AbortController();

    fetchQuotas(controller.signal)
      .then(setQuotas)
      .catch(() => {
        /*
         * Shown as nothing rather than as an error.
         *
         * This is a line of context beside a list of projects. A failure to
         * fetch it is not something to interrupt somebody with, and the limits
         * are enforced on the server either way.
         */
      });

    return () => controller.abort();
  }, []);

  const inUse = quotas.filter((quota) => quota.used > 0);
  if (inUse.length === 0) return null;

  return (
    <p className="account-usage">
      {inUse.map((quota) => (
        <span
          key={quota.kind}
          className={
            isQuotaFull(quota)
              ? 'account-usage__item account-usage__item--full'
              : 'account-usage__item'
          }
        >
          {QUOTA_LABELS[quota.kind]}: {quota.used} of {quota.limit}
          {/* Said where it can be acted on. Finding out at the moment Start is
              refused is finding out too late to have planned around it. */}
          {isQuotaFull(quota) ? ' — at the limit' : ''}
        </span>
      ))}
    </p>
  );
}
