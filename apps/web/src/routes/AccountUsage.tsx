import { useEffect, useId, type ReactElement } from 'react';
import { QUOTA_LABELS, QUOTA_KINDS, isQuotaFull, type QuotaUsage } from '@platform/shared';
import { fetchQuotas } from '../lib/quotas-api.js';
import { useResource } from '../lib/use-resource.js';
import { Button, Callout, Card, IconButton, Meter, Popover } from '../ui/index.js';
import { ArrowClockwise, Question } from '../ui/icons.js';

/** What to do when a ceiling is reached, in the words of the thing that is full. */
const FULL_ADVICE: Partial<Record<QuotaUsage['kind'], string>> = {
  RUNTIMES: 'Stop an environment to free a slot.',
  DEPLOYMENTS: 'Stop a deployment to free a slot.',
};

export interface AccountUsageProps {
  className?: string;
}

/**
 * How much of the platform this account is using at once.
 *
 * On the project list rather than inside a project, because the ceiling is
 * per account: whoever wonders why Start was refused is looking at the wrong
 * project by definition. Always visible, so a limit is learned before it is
 * hit; read again whenever the tab comes back into view.
 */
export function AccountUsage({ className }: AccountUsageProps): ReactElement {
  const headingId = useId();
  const quotas = useResource((signal) => fetchQuotas(signal), []);
  const { reload } = quotas;

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') reload();
    };
    window.addEventListener('focus', reload);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', reload);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  return (
    <Card
      as="section"
      className={className ? `usage ${className}` : 'usage'}
      aria-labelledby={headingId}
    >
      <header className="usage__head">
        <h2 id={headingId} className="usage__title">
          Usage
        </h2>
        <Popover
          trigger={<IconButton label="About these limits" icon={Question} size="sm" />}
          title="Account limits"
          align="end"
        >
          <p className="usage__help">
            Each account may have a few environments, deployments and builds going at once, across
            all of its projects, so nobody can fill a machine everyone shares. Shared projects count
            against their owner.
          </p>
        </Popover>
      </header>

      {quotas.data ? (
        <ul className="usage__list">
          {quotas.data.map((quota) => (
            <li key={quota.kind} className="usage__row">
              <Meter
                value={quota.used}
                max={quota.limit}
                label={QUOTA_LABELS[quota.kind]}
                format={(value) => `${value} of ${quota.limit}`}
              />
              {isQuotaFull(quota) && FULL_ADVICE[quota.kind] ? (
                <p className="usage__advice" role="status">
                  {FULL_ADVICE[quota.kind]}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : quotas.status === 'error' ? (
        <Callout
          tone="danger"
          title="Could not read your usage."
          action={
            <Button size="sm" icon={ArrowClockwise} onClick={reload}>
              Retry
            </Button>
          }
        />
      ) : (
        <ul className="usage__list" aria-busy="true">
          {QUOTA_KINDS.map((kind) => (
            <li key={kind} className="usage__row">
              <Meter value={null} max={1} label={QUOTA_LABELS[kind]} loading />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
