import { QUOTA_KINDS, QUOTA_LABELS, isQuotaFull } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { fetchQuotas } from '../../lib/quotas-api.js';
import { useResource } from '../../lib/use-resource.js';
import { Button, Callout, Meter, SectionHeader } from '../../ui/index.js';

const LABEL_WIDTH = '10rem';

export function UsageSection(): React.JSX.Element {
  const quotas = useResource((signal) => fetchQuotas(signal), []);
  const full = (quotas.data ?? []).filter(isQuotaFull);

  return (
    <section className="account-section" aria-labelledby="usage-heading">
      <SectionHeader
        id="usage-heading"
        title="Usage"
        description="What this account is using right now, across all of its projects."
      />

      {quotas.status === 'error' ? (
        <Callout
          tone="danger"
          title={
            quotas.error instanceof ApiError ? quotas.error.message : 'Could not read your usage.'
          }
          action={
            <Button size="sm" onClick={quotas.reload}>
              Retry
            </Button>
          }
        />
      ) : (
        <div className="usage__meters" aria-busy={quotas.status === 'loading' || undefined}>
          {quotas.status === 'loading'
            ? QUOTA_KINDS.map((kind) => (
                <Meter
                  key={kind}
                  value={null}
                  max={1}
                  label={QUOTA_LABELS[kind]}
                  labelWidth={LABEL_WIDTH}
                  loading
                />
              ))
            : (quotas.data ?? []).map((quota) => (
                <Meter
                  key={quota.kind}
                  value={quota.used}
                  max={quota.limit}
                  label={QUOTA_LABELS[quota.kind]}
                  labelWidth={LABEL_WIDTH}
                  format={(value) => `${value} of ${quota.limit}`}
                />
              ))}
        </div>
      )}

      {full.length > 0 ? (
        <Callout
          tone="warn"
          title={`${full.map((quota) => QUOTA_LABELS[quota.kind]).join(', ')}: at the limit.`}
        >
          Stop an environment or a deployment in one of your projects to make room for another.
        </Callout>
      ) : quotas.status === 'ready' ? (
        <Callout tone="info" title="Limits are per account.">
          A refused Start or Deploy in one project may be because of what is running in another.
        </Callout>
      ) : null}
    </section>
  );
}
