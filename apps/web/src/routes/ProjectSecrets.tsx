import { useCallback, useEffect, useState } from 'react';
import type { SecretSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { deleteSecret, fetchSecrets, setSecret } from '../lib/project-storage-api.js';

/**
 * A project's secrets.
 *
 * Values go in and never come out, so there is nothing here that shows one:
 * not masked, not partly, not on request. The interface says as much in
 * plain words, because a field that looks like it holds a value invites
 * someone to go looking for a way to see it.
 */
export function ProjectSecrets({ projectId }: { projectId: string }): React.JSX.Element {
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const listed = await fetchSecrets(projectId, signal);
        if (signal?.aborted) return;
        setSecrets(listed.secrets);
        setUnavailable(listed.unavailableReason);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The secrets could not be loaded.');
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
  }, [load]);

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      await setSecret(projectId, { key, value });
      setKey('');
      // Cleared immediately. The value has no reason to stay in the page after
      // it has been sent.
      setValue('');
      await load();
    } catch (cause) {
      /*
       * The precise reason, not the general one.
       *
       * A rejected name comes back with a field-level message saying which
       * rule it broke, and the top-level message is only "that name cannot be
       * used". Showing the general one throws away the half that tells someone
       * what to change.
       */
      const { fields, message } = fieldErrorsFrom(cause);
      setError(
        fields.key ??
          fields.value ??
          message ??
          (cause instanceof ApiError ? cause.message : 'The secret could not be saved.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (secret: SecretSummary): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await deleteSecret(projectId, secret.key);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The secret could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-section" aria-labelledby="secrets-heading">
      <h2 id="secrets-heading">Secrets</h2>
      <p className="project-section__hint">
        Environment variables the project needs, encrypted and given to it when it runs. Values
        cannot be read back, by anyone. Replace one you have forgotten.
      </p>

      {unavailable && (
        <p className="project-section__error" role="status">
          {unavailable}
        </p>
      )}

      {!unavailable && (
        <form className="project-section__form" onSubmit={(event) => void save(event)}>
          <label htmlFor="secret-key">Name</label>
          <input
            id="secret-key"
            value={key}
            onChange={(event) => setKey(event.target.value.toUpperCase())}
            placeholder="API_TOKEN"
            autoComplete="off"
            required
          />

          <label htmlFor="secret-value">Value</label>
          <input
            id="secret-value"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            // Off, so a browser never keeps a project's credential in a
            // password manager entry belonging to this platform.
            autoComplete="off"
            required
          />

          <button type="submit" className="button-quiet" disabled={busy}>
            {busy ? 'Saving…' : 'Save secret'}
          </button>
        </form>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="project-section__note">Loading secrets…</p>}

      {!loading && secrets.length === 0 && <p className="project-section__note">No secrets yet.</p>}

      {secrets.length > 0 && (
        <ul className="project-section__list">
          {secrets.map((secret) => (
            <li key={secret.key} className="project-section__item">
              <span className="project-section__item-name">{secret.key}</span>
              {/* Dots, and deliberately not the value's own length rounded to
                  something recognisable. It says a value is set and no more. */}
              <span className="project-section__item-meta" aria-label="Value is hidden">
                ••••••••
              </span>
              <span className="project-section__item-meta">
                set {new Date(secret.updatedAt).toLocaleDateString()}
              </span>
              <button
                type="button"
                className="icon-button"
                disabled={busy}
                onClick={() => void remove(secret)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
