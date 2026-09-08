import { useCallback, useEffect, useState } from 'react';
import { verificationRecordName, type CustomDomainSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import {
  addCustomDomain,
  fetchDomains,
  removeCustomDomain,
  setDeploymentSubdomain,
  verifyCustomDomain,
} from '../lib/domains-api.js';

/**
 * Where this project is published.
 *
 * Two kinds of address, and the page is built around the difference rather than
 * hiding it. The label under the platform's own domain is a setting: type a
 * name, it is yours. A custom domain is a claim about a name somebody owns, and
 * nothing is served on one until that ownership has been proved — so the form
 * for it is mostly instructions, and the button says "check" rather than "save".
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
  const [domains, setDomains] = useState<CustomDomainSummary[]>([]);
  const [subdomain, setSubdomain] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [limit, setLimit] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [label, setLabel] = useState('');
  const [hostname, setHostname] = useState('');
  const [confirming, setConfirming] = useState<string | undefined>();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const listed = await fetchDomains(projectId, signal);
        if (signal?.aborted) return;
        setDomains(listed.domains);
        setSubdomain(listed.subdomain);
        setTarget(listed.target);
        setUnavailable(listed.unavailableReason);
        setLimit(listed.limit);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The addresses could not be loaded.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // Reloaded when a first deployment assigns an address, which happens in the
    // deployments section above.
  }, [load, addressNonce]);

  /*
   * The field follows the stored address until somebody types in it.
   *
   * Keyed on the stored value rather than synchronised on every render, so a
   * reload landing while somebody is halfway through typing a new name does not
   * replace what they were typing.
   */
  useEffect(() => {
    setLabel(subdomain ?? '');
  }, [subdomain]);

  const saveLabel = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      await setDeploymentSubdomain(projectId, label);
      // The deployments section above shows the address, so it is told rather
      // than left to find out on its next load.
      onSubdomainChanged();
      await load();
    } catch (cause) {
      const { fields, message } = fieldErrorsFrom(cause);
      setError(
        fields.subdomain ??
          message ??
          (cause instanceof ApiError ? cause.message : 'That address could not be set.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const add = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      await addCustomDomain(projectId, hostname);
      setHostname('');
      await load();
    } catch (cause) {
      const { fields, message } = fieldErrorsFrom(cause);
      setError(
        fields.hostname ??
          message ??
          (cause instanceof ApiError ? cause.message : 'That domain could not be added.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const verify = async (domain: CustomDomainSummary): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await verifyCustomDomain(projectId, domain.id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That domain could not be checked.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (domain: CustomDomainSummary): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setConfirming(undefined);
    try {
      await removeCustomDomain(projectId, domain.id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That domain could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  const full = domains.length >= limit && limit > 0;

  return (
    <section className="project-section" aria-labelledby="domains-heading">
      <h2 id="domains-heading">Addresses</h2>
      <p className="project-section__hint">
        Where this project answers when it is deployed. The name below is under this platform&apos;s
        own domain and is yours as soon as you set it. A domain of your own has to be pointed here
        first, and nothing is served on it until that has been checked.
      </p>

      <form className="project-section__form" onSubmit={(event) => void saveLabel(event)}>
        <label htmlFor="deployment-subdomain">Address on this platform</label>
        <input
          id="deployment-subdomain"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={subdomain ?? 'Assigned when you first deploy'}
          autoComplete="off"
        />
        <button type="submit" className="button-quiet" disabled={busy || label.length === 0}>
          {busy ? 'Saving…' : 'Set address'}
        </button>
      </form>

      {/* Said plainly: changing this takes the old address away from everybody
          who had it, which is not obvious from a text field. */}
      {subdomain && (
        <p className="project-section__note">
          Changing this address stops the old one working. Anybody who had the old link will get a
          page saying nothing is deployed there.
        </p>
      )}

      <h3 className="project-section__subheading">Your own domain</h3>

      {unavailable && (
        <p className="project-section__error" role="status">
          {unavailable}
        </p>
      )}

      {!unavailable && (
        <form className="project-section__form" onSubmit={(event) => void add(event)}>
          <label htmlFor="custom-domain">Domain</label>
          <input
            id="custom-domain"
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder="www.example.com"
            autoComplete="off"
            required
          />
          <button type="submit" className="button-quiet" disabled={busy || full}>
            {busy ? 'Adding…' : 'Add domain'}
          </button>
        </form>
      )}

      {full && (
        <p className="project-section__note" role="status">
          This project has its limit of {limit} domains. Remove one to add another.
        </p>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="project-section__note">Loading addresses…</p>}

      {!loading && domains.length === 0 && !unavailable && (
        <p className="project-section__note">No domains of your own yet.</p>
      )}

      {domains.length > 0 && (
        <ul className="project-section__list">
          {domains.map((domain) => (
            <li key={domain.id} className="project-section__item">
              <span className="project-section__item-name">{domain.hostname}</span>
              <span className="project-section__item-meta">{statusLabel(domain)}</span>

              {domain.message && (
                <span className="project-section__item-value">{domain.message}</span>
              )}

              {/* The instructions, beside the domain they are for, and only
                  while they are still needed. */}
              {domain.status !== 'VERIFIED' && (
                <div className="project-section__item-value">
                  <p>Point this domain here with either of these, then press Check:</p>
                  <pre className="build-log">
                    {`TXT   ${verificationRecordName(domain.hostname)}\n      ${domain.verificationToken}\n\nCNAME ${domain.hostname}\n      ${target ?? 'deploy this project first'}`}
                  </pre>
                </div>
              )}

              <button
                type="button"
                className="icon-button"
                disabled={busy}
                onClick={() => void verify(domain)}
              >
                Check
              </button>

              {confirming === domain.id ? (
                <>
                  <button
                    type="button"
                    className="button-danger"
                    disabled={busy}
                    onClick={() => void remove(domain)}
                  >
                    Yes, remove it
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setConfirming(undefined)}
                  >
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  onClick={() => setConfirming(domain.id)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Where a domain stands, in the words the page uses. */
function statusLabel(domain: CustomDomainSummary): string {
  switch (domain.status) {
    case 'VERIFIED':
      return domain.verifiedAt
        ? `Serving since ${new Date(domain.verifiedAt).toLocaleDateString()}`
        : 'Serving';
    case 'FAILED':
      return 'No longer pointed here';
    case 'PENDING':
    default:
      return 'Waiting to be checked';
  }
}
