import { useEffect, useState, type FormEvent } from 'react';
import { verificationRecordName, type CustomDomainSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import {
  addCustomDomain,
  fetchDomains,
  removeCustomDomain,
  setDeploymentSubdomain,
  verifyCustomDomain,
} from '../lib/domains-api.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import { ArrowsClockwise, Globe, Trash } from '../ui/icons.js';
import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  FormRow,
  Input,
  ListRow,
  RelativeTime,
  RowActions,
  SectionHeader,
  Skeleton,
  toast,
  type Tone,
} from '../ui/index.js';
import './ship/ship.css';

/**
 * Where a deployed project answers: its platform subdomain and the custom
 * domains pointed at it.
 *
 * The subdomain is a setting; a custom domain is a claim that has to be
 * proved by a DNS record before anything is served on it, so each unverified
 * domain carries its record and a Check beside it.
 */
export function ProjectDomains({
  projectId,
  addressNonce,
  onSubdomainChanged,
}: {
  projectId: string;
  /** Bumped when the address changed somewhere else on the page. */
  addressNonce: number;
  onSubdomainChanged: () => void;
}): React.JSX.Element {
  const state = useResource(
    (signal) => fetchDomains(projectId, signal),
    // Reloaded when a first deployment assigns the subdomain, which happens in
    // the Deployments section above.
    [projectId, addressNonce],
  );
  const data = state.data;
  const [removing, setRemoving] = useState<CustomDomainSummary>();
  /** Which domain is being checked, so only its own button is busy. */
  const [checking, setChecking] = useState<string>();

  const check = async (domain: CustomDomainSummary): Promise<void> => {
    setChecking(domain.id);
    try {
      const checked = await verifyCustomDomain(projectId, domain.id);
      toast(
        checked.status === 'VERIFIED'
          ? { tone: 'success', title: `${domain.hostname} is verified` }
          : {
              tone: 'warn',
              title: `${domain.hostname} is not pointed here yet`,
              ...(checked.message ? { description: checked.message } : {}),
            },
      );
      state.reload();
    } catch (cause) {
      toast({
        tone: 'danger',
        title: `${domain.hostname} could not be checked`,
        ...(cause instanceof ApiError ? { description: cause.message } : {}),
      });
    } finally {
      setChecking(undefined);
    }
  };

  return (
    <section className="ship-section">
      <SectionHeader
        title="Domains"
        icon={Globe}
        description="The platform subdomain is yours as soon as the project is deployed; a custom domain is served once its DNS points here."
      />

      {state.status === 'error' && !data ? (
        <Callout
          tone="danger"
          title={
            state.error instanceof ApiError ? state.error.message : 'Domains could not be loaded.'
          }
          action={
            <Button size="sm" onClick={state.reload}>
              Retry
            </Button>
          }
        />
      ) : null}

      {!data && state.status === 'loading' ? (
        <div className="ship-list__skeleton" aria-busy="true">
          <Skeleton shape="row" />
          <Skeleton shape="row" />
        </div>
      ) : null}

      {data && data.subdomain === null ? (
        <EmptyState
          size="panel"
          icon={Globe}
          title="Your platform subdomain is assigned on the first deploy."
          body="Custom domains can be added once the project has an address to point them at."
          action={
            <Button asChild variant="primary">
              <a href="#deploy-deployments">Go to Deployments</a>
            </Button>
          }
        />
      ) : null}

      {data && data.subdomain !== null ? (
        <>
          <SubdomainForm
            projectId={projectId}
            subdomain={data.subdomain}
            target={data.target}
            onChanged={() => {
              onSubdomainChanged();
              state.reload();
            }}
          />

          <h3 className="ship-subheading">Custom domains</h3>

          {data.unavailableReason ? (
            <Callout tone="info" title="Custom domains are not available on this installation.">
              {data.unavailableReason}
            </Callout>
          ) : (
            <AddDomainForm
              projectId={projectId}
              count={data.domains.length}
              limit={data.limit}
              onAdded={state.reload}
            />
          )}

          {data.domains.length === 0 ? (
            data.unavailableReason ? null : (
              <p className="ship-list__count">No custom domains yet.</p>
            )
          ) : (
            <>
              <ul className="ship-list" aria-label="Custom domains">
                {data.domains.map((domain) => (
                  <DomainRow
                    key={domain.id}
                    domain={domain}
                    target={data.target}
                    checking={checking === domain.id}
                    onCheck={() => void check(domain)}
                    onRemove={() => setRemoving(domain)}
                  />
                ))}
              </ul>
              <p className="ship-list__count">
                {data.domains.length} of {data.limit} custom domains.
              </p>
            </>
          )}
        </>
      ) : null}

      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        tone="danger"
        title={removing ? `Remove ${removing.hostname}?` : 'Remove?'}
        body="The domain stops reaching this project. Its DNS records are yours to clean up."
        confirmLabel={removing ? `Remove ${removing.hostname}` : 'Remove'}
        onConfirm={async () => {
          if (!removing) return;
          await removeCustomDomain(projectId, removing.id);
          toast({ tone: 'success', title: `${removing.hostname} removed` });
          state.reload();
        }}
      />
    </section>
  );
}

/** The part of the target after the project's own label: the platform's domain. */
function suffixOf(subdomain: string, target: string | null): string | undefined {
  if (!target) return undefined;
  const prefix = `${subdomain}.`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : undefined;
}

function SubdomainForm({
  projectId,
  subdomain,
  target,
  onChanged,
}: {
  projectId: string;
  subdomain: string;
  target: string | null;
  onChanged: () => void;
}): React.JSX.Element {
  const [label, setLabel] = useState(subdomain);
  const [confirming, setConfirming] = useState(false);
  const [fieldError, setFieldError] = useState<string>();
  // Follows the stored value when it changes elsewhere, not on every poll.
  useEffect(() => setLabel(subdomain), [subdomain]);

  const trimmed = label.trim().toLowerCase();
  const suffix = suffixOf(subdomain, target);
  const preview = suffix ? `${trimmed || '…'}.${suffix}` : trimmed;
  const reason =
    trimmed.length === 0
      ? 'Enter a name'
      : trimmed === subdomain
        ? 'This is the current subdomain'
        : undefined;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (reason) return;
    setConfirming(true);
  };

  return (
    <form className="ship-form" onSubmit={onSubmit} noValidate>
      <FormRow
        label="Platform subdomain"
        htmlFor="deployment-subdomain"
        hint="Under the platform's own domain."
      >
        <Input
          id="deployment-subdomain"
          mono
          value={label}
          invalid={fieldError !== undefined}
          aria-describedby={
            fieldError ? 'deployment-subdomain-error' : 'deployment-subdomain-preview'
          }
          onChange={(event) => {
            setLabel(event.target.value);
            setFieldError(undefined);
          }}
          autoComplete="off"
        />
        <span id="deployment-subdomain-preview" className="ship-preview">
          {preview}
          {suffix && trimmed ? (
            <CopyButton value={preview} label="Copy platform subdomain" size="sm" />
          ) : null}
        </span>
        {fieldError ? (
          <p id="deployment-subdomain-error" className="ship-row__problem" role="alert">
            {fieldError}
          </p>
        ) : null}
      </FormRow>
      <div className="ship-form__actions">
        <Button type="submit" variant="secondary" {...(reason ? { disabledReason: reason } : {})}>
          Change subdomain
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Change the subdomain to ${preview}?`}
        body="Links to the old address stop working. Anyone who had the old link sees a page saying nothing is deployed there."
        confirmLabel="Change subdomain"
        onConfirm={async () => {
          try {
            await setDeploymentSubdomain(projectId, trimmed);
          } catch (cause) {
            const { fields } = fieldErrorsFrom(cause);
            if (fields.subdomain) setFieldError(fields.subdomain);
            throw cause;
          }
          toast({ tone: 'success', title: `Subdomain changed to ${preview}` });
          onChanged();
        }}
      />
    </form>
  );
}

function AddDomainForm({
  projectId,
  count,
  limit,
  onAdded,
}: {
  projectId: string;
  count: number;
  limit: number;
  onAdded: () => void;
}): React.JSX.Element {
  const [hostname, setHostname] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const add = useAction(() => addCustomDomain(projectId, hostname.trim()));
  const full = count >= limit;

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (hostname.trim() === '') {
      setFieldError('Enter a domain name');
      return;
    }
    const outcome = await add.run();
    if (outcome.ok) {
      setHostname('');
      toast({
        tone: 'success',
        title: `${outcome.value.hostname} added`,
        description: 'Add the DNS record shown below it, then press Check.',
      });
      onAdded();
      return;
    }
    const { fields, message } = fieldErrorsFrom(outcome.error);
    setFieldError(
      fields.hostname ??
        message ??
        (outcome.error instanceof ApiError
          ? outcome.error.message
          : 'That domain could not be added.'),
    );
  };

  return (
    <form className="ship-form" onSubmit={(event) => void onSubmit(event)} noValidate>
      <FormRow
        label="Custom domain"
        htmlFor="custom-domain"
        hint="A name you own, such as www.example.com."
      >
        <Input
          id="custom-domain"
          mono
          value={hostname}
          invalid={fieldError !== undefined}
          aria-describedby={fieldError ? 'custom-domain-error' : undefined}
          onChange={(event) => {
            setHostname(event.target.value);
            setFieldError(undefined);
          }}
          placeholder="www.example.com"
          autoComplete="off"
        />
        {fieldError ? (
          <p id="custom-domain-error" className="ship-row__problem" role="alert">
            {fieldError}
          </p>
        ) : null}
      </FormRow>
      <div className="ship-form__actions">
        <Button
          type="submit"
          variant="secondary"
          loading={add.busy}
          {...(full
            ? {
                disabledReason: `This project has its limit of ${limit} domains. Remove one to add another.`,
              }
            : {})}
        >
          Add domain
        </Button>
      </div>
    </form>
  );
}

interface DomainWords {
  word: string;
  tone: Tone;
}

/** Where a domain stands, in the words the page uses. */
function describeDomain(domain: CustomDomainSummary): DomainWords {
  switch (domain.status) {
    case 'VERIFIED':
      return { word: 'Verified', tone: 'ok' };
    case 'FAILED':
      return { word: 'Not pointed here', tone: 'danger' };
    case 'PENDING':
    default:
      return { word: 'Waiting for DNS', tone: 'warn' };
  }
}

function DomainRow({
  domain,
  target,
  checking,
  onCheck,
  onRemove,
}: {
  domain: CustomDomainSummary;
  target: string | null;
  checking: boolean;
  onCheck: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const words = describeDomain(domain);
  const verified = domain.status === 'VERIFIED';
  const record = `TXT   ${verificationRecordName(domain.hostname)}\n      ${domain.verificationToken}\n\nCNAME ${domain.hostname}\n      ${target ?? '(assigned on the first deploy)'}`;

  return (
    <ListRow
      title={<span className="ship-row__link">{domain.hostname}</span>}
      badge={<Badge tone={words.tone}>{words.word}</Badge>}
      description={
        <span className="ship-row__line">
          {domain.lastCheckedAt ? (
            <RelativeTime value={domain.lastCheckedAt} prefix="Checked" />
          ) : (
            <span>Not checked yet</span>
          )}
          {verified && domain.verifiedAt ? (
            <RelativeTime value={domain.verifiedAt} prefix="Verified" />
          ) : null}
          {!verified && domain.message ? (
            <span className="ship-row__problem">{domain.message}</span>
          ) : null}
        </span>
      }
      actions={
        <span className="ship-row__line">
          {!verified ? (
            <Button
              size="sm"
              variant="secondary"
              icon={ArrowsClockwise}
              loading={checking}
              loadingLabel={`Checking ${domain.hostname}`}
              aria-label={`Check ${domain.hostname}`}
              onClick={onCheck}
            >
              Check
            </Button>
          ) : null}
          <RowActions
            objectName={domain.hostname}
            items={[{ label: 'Remove', icon: Trash, tone: 'danger', onSelect: onRemove }]}
          />
        </span>
      }
      expanded={
        verified ? undefined : (
          <div className="ship-dns">
            <p className="ship-dns__text">
              Add either record at your DNS provider, then press Check. The TXT record proves you
              own the name; the CNAME sends visitors here.
            </p>
            <CodeBlock code={record} label={`DNS record for ${domain.hostname}`} copy />
          </div>
        )
      }
    />
  );
}
