import { QUOTA_LABELS, type QuotaKind } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { fetchAuditTrail, type AuditEntry } from '../../lib/operations-api.js';
import { useResource } from '../../lib/use-resource.js';
import { Scroll } from '../../ui/icons.js';
import { CodeBlock, RelativeTime, SectionHeader, Table, type TableColumn } from '../../ui/index.js';

/**
 * What operators have done, newest first.
 *
 * Read-only, and there is no way to remove an entry from here or anywhere
 * else: a trail the people it records could tidy would not be a trail.
 */
export function Audit(): React.JSX.Element {
  const list = useResource((signal) => fetchAuditTrail(signal), []);
  const entries = list.data ?? [];
  const errorMessage =
    list.status === 'error'
      ? list.error instanceof ApiError
        ? list.error.message
        : 'The audit trail could not be loaded.'
      : undefined;

  const columns: TableColumn<AuditEntry>[] = [
    {
      key: 'when',
      header: 'When',
      width: '1%',
      cell: (entry) => <RelativeTime value={entry.at} className="audit__when" />,
    },
    {
      key: 'what',
      header: 'What happened',
      // The details sit under the sentence rather than in a column of their
      // own, so the JSON has the whole row's width on a phone.
      cell: (entry) => (
        <div className="audit__what">
          <span>{describeEntry(entry)}</span>
          {entry.detail != null ? (
            <details className="audit__details">
              <summary className="audit__summary">Details</summary>
              <CodeBlock
                label={`Details of ${describeEntry(entry)}`}
                code={JSON.stringify(entry.detail, null, 2)}
                wrap
              />
            </details>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <section className="operations-section" aria-labelledby="audit-heading">
      <SectionHeader
        id="audit-heading"
        title="Audit trail"
        description="Every operator action on this installation, newest first. Entries cannot be edited or removed."
        {...(list.data ? { count: entries.length } : {})}
      />
      <Table
        caption="Operator actions"
        columns={columns}
        rows={entries}
        rowKey={(entry) => entry.id}
        loading={list.status === 'loading'}
        {...(errorMessage ? { error: errorMessage, onRetry: list.reload } : {})}
        empty={{
          icon: Scroll,
          title: 'No operator actions yet.',
          body: 'Draining a host, changing limits, making an operator and running cleanup are recorded here.',
        }}
      />
    </section>
  );
}

/** A plain sentence per action; unknown actions fall back to the raw verb so nothing is hidden. */
export function describeEntry(entry: AuditEntry): string {
  const detail = isRecord(entry.detail) ? entry.detail : {};
  const target = entry.target ?? 'an account';
  switch (entry.action) {
    case 'host.drain':
      return `${entry.actor} drained ${hostOf(detail)}`;
    case 'host.undrain':
      return `${entry.actor} resumed placing work on ${hostOf(detail)}`;
    case 'quota.override': {
      const kind =
        typeof detail.kind === 'string' ? QUOTA_LABELS[detail.kind as QuotaKind] : undefined;
      const limit = typeof detail.limit === 'number' ? detail.limit : undefined;
      return kind && limit !== undefined
        ? `${entry.actor} set ${kind} for ${target} to ${limit}`
        : `${entry.actor} changed the limits of ${target}`;
    }
    case 'quota.reset': {
      const kind =
        typeof detail.kind === 'string' ? QUOTA_LABELS[detail.kind as QuotaKind] : undefined;
      return kind
        ? `${entry.actor} put ${kind} for ${target} back on the default`
        : `${entry.actor} put ${target} back on the default limits`;
    }
    case 'operator.grant':
      return `${target} was made an operator by ${entry.actor}`;
    case 'operator.revoke':
      return `${target} was removed as an operator by ${entry.actor}`;
    case 'sweep.run':
      return detail.dryRun === true
        ? `${entry.actor} ran a cleanup dry run`
        : `${entry.actor} ran a cleanup sweep`;
    default:
      return `${entry.actor}: ${entry.action}${entry.target ? ` (${entry.target})` : ''}`;
  }
}

function hostOf(detail: Record<string, unknown>): string {
  return typeof detail.host === 'string' ? detail.host : 'a host';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
