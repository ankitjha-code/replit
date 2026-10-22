import { useState, type FormEvent } from 'react';
import type { PreviewShare } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { formatDateTime } from '../lib/format.js';
import { createPreviewShare, fetchPreviewShares, revokePreviewShare } from '../lib/preview-api.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import { Link, XCircle } from '../ui/icons.js';
import {
  Button,
  Callout,
  ConfirmDialog,
  CopyButton,
  FormRow,
  Input,
  RelativeTime,
  SectionHeader,
  Select,
  Table,
  toast,
} from '../ui/index.js';
import './ship/ship.css';

const DURATIONS = [
  { value: '1', label: '1 hour' },
  { value: '24', label: '1 day' },
  { value: '72', label: '3 days' },
  { value: '168', label: '1 week' },
];

export function ProjectPreviewShares({ projectId }: { projectId: string }): React.JSX.Element {
  const shares = useResource((signal) => fetchPreviewShares(projectId, signal), [projectId]);
  const [hours, setHours] = useState('24');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [revoking, setRevoking] = useState<PreviewShare>();

  const make = useAction(() => {
    const trimmed = label.trim();
    return createPreviewShare(projectId, {
      hours: Number(hours),
      ...(trimmed ? { label: trimmed } : {}),
    });
  });

  const onMake = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    setCreated(undefined);
    const outcome = await make.run();
    if (outcome.ok) {
      setCreated(outcome.value.url);
      setLabel('');
      toast({ tone: 'success', title: 'Preview link made' });
      shares.reload();
      return;
    }
    const { fields, message } = fieldErrorsFrom(outcome.error);
    setFormError(
      fields.hours ??
        fields.label ??
        message ??
        (outcome.error instanceof ApiError ? outcome.error.message : 'The link could not be made.'),
    );
  };

  const now = Date.now();
  const active = (shares.data ?? []).filter(
    (share) => !share.revokedAt && Date.parse(share.expiresAt) > now,
  );
  const nameOf = (share: PreviewShare): string => share.label ?? formatDateTime(share.createdAt);

  return (
    <section className="ship-section">
      <SectionHeader
        title="Preview links"
        icon={Link}
        description="A link shows the running app to anyone who has it, for a limited time. For something that stays up, deploy instead."
      />

      <form className="ship-form" onSubmit={(event) => void onMake(event)} noValidate>
        <FormRow label="Works for" htmlFor="share-hours">
          <Select id="share-hours" value={hours} options={DURATIONS} onValueChange={setHours} />
        </FormRow>
        <FormRow label="Note (optional)" htmlFor="share-label" hint="Who the link is for.">
          <Input
            id="share-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Who it is for"
            maxLength={100}
            autoComplete="off"
          />
        </FormRow>
        {formError ? <Callout tone="danger" title={formError} /> : null}
        <div className="ship-form__actions">
          <Button type="submit" variant="secondary" loading={make.busy}>
            Make link
          </Button>
        </div>
      </form>

      {created ? (
        <Callout tone="ok" title="Copy this now. It will not be shown again.">
          <div className="ship-created">
            <Input
              aria-label="New share link"
              readOnly
              mono
              value={created}
              onFocus={(event) => event.currentTarget.select()}
              trailing={<CopyButton value={created} label="Copy preview link" size="sm" />}
            />
          </div>
        </Callout>
      ) : null}

      <Table
        caption="Active preview links"
        columns={[
          { key: 'note', header: 'Note', cell: (share) => share.label ?? 'Untitled link' },
          {
            key: 'expires',
            header: 'Expires',
            cell: (share) => <RelativeTime value={share.expiresAt} />,
          },
          {
            key: 'by',
            header: 'Made by',
            cell: (share) => share.createdBy ?? 'Unknown',
          },
        ]}
        rows={active}
        rowKey={(share) => share.id}
        rowName={nameOf}
        rowActions={(share) => [
          {
            label: 'Revoke link for',
            icon: XCircle,
            tone: 'danger',
            onSelect: () => setRevoking(share),
          },
        ]}
        loading={shares.status === 'loading'}
        {...(shares.status === 'error'
          ? {
              error:
                shares.error instanceof ApiError
                  ? shares.error.message
                  : 'Preview links could not be loaded.',
              onRetry: shares.reload,
            }
          : {})}
        empty={{
          icon: Link,
          title: 'No active preview links.',
          body: 'Make one above to show the running app to someone without an account.',
        }}
      />

      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        tone="danger"
        title="Revoke this link?"
        body="Anyone using it loses access now."
        confirmLabel={revoking ? `Revoke link for ${nameOf(revoking)}` : 'Revoke link'}
        onConfirm={async () => {
          if (!revoking) return;
          await revokePreviewShare(projectId, revoking.id);
          toast({ tone: 'success', title: 'Preview link revoked' });
          shares.reload();
        }}
      />
    </section>
  );
}
