import { useCallback, useEffect, useState } from 'react';
import {
  parseDotenv,
  type ImportEnvironmentResponse,
  type ProjectVariable,
} from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import {
  deleteVariable,
  fetchVariables,
  importEnvironment,
  setVariable,
} from '../lib/project-storage-api.js';

/**
 * A project's environment variables.
 *
 * The deliberate opposite of the secrets panel below it. Values are shown,
 * because a port number or a log level that nobody can read is one nobody can
 * check or correct, and someone handed a project they did not configure needs
 * to be able to see what it is running on.
 *
 * Editing one is therefore a real edit: the field starts with the current
 * value in it, rather than empty and waiting to overwrite something invisible.
 */
export function ProjectVariables({
  projectId,
  canWrite,
}: {
  projectId: string;
  canWrite: boolean;
}): React.JSX.Element {
  const [variables, setVariables] = useState<ProjectVariable[]>([]);
  const [restartRequired, setRestartRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const listed = await fetchVariables(projectId, signal);
        if (signal?.aborted) return;
        setVariables(listed.variables);
        setRestartRequired(listed.restartRequired);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(
          cause instanceof ApiError
            ? cause.message
            : 'The environment variables could not be loaded.',
        );
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
      await setVariable(projectId, { key, value });
      setKey('');
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
          (cause instanceof ApiError ? cause.message : 'The variable could not be saved.'),
      );
    } finally {
      setBusy(false);
    }
  };

  /** Puts an existing variable into the form, so editing is editing. */
  const edit = (variable: ProjectVariable): void => {
    setKey(variable.key);
    setValue(variable.value);
    setError(undefined);
  };

  const remove = async (variable: ProjectVariable): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await deleteVariable(projectId, variable.key);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The variable could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-section" aria-labelledby="variables-heading">
      <h2 id="variables-heading">Environment variables</h2>
      <p className="project-section__hint">
        Configuration the project is given when it runs, and which anyone who can edit the project
        can read. Anything that would be damaging to read belongs in Secrets instead.
      </p>

      {/* A container is handed its environment when it is created, so an edit
          changes the next start and not the one that is up. Saying so is the
          difference between restarting and wondering why nothing happened. */}
      {restartRequired && (
        <p className="project-section__note" role="status">
          The project is running with the values it started with. Restart it for changes here to
          take effect.
        </p>
      )}

      {canWrite && (
        <form className="project-section__form" onSubmit={(event) => void save(event)}>
          <label htmlFor="variable-key">Variable name</label>
          <input
            id="variable-key"
            value={key}
            onChange={(event) => setKey(event.target.value.toUpperCase())}
            placeholder="LOG_LEVEL"
            autoComplete="off"
            required
          />

          <label htmlFor="variable-value">Variable value</label>
          <input
            id="variable-value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="debug"
            autoComplete="off"
          />

          <button type="submit" className="button-quiet" disabled={busy}>
            {busy ? 'Saving…' : 'Save variable'}
          </button>
        </form>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="project-section__note">Loading environment variables…</p>}

      {!loading && variables.length === 0 && (
        <p className="project-section__note">No environment variables yet.</p>
      )}

      {variables.length > 0 && (
        <ul className="project-section__list">
          {variables.map((variable) => (
            <li key={variable.key} className="project-section__item">
              <span className="project-section__item-name">{variable.key}</span>
              {/* Shown, in full. An empty value is named rather than drawn as
                  a blank, which is indistinguishable from a missing one. */}
              <span className="project-section__item-value">
                {variable.value === '' ? <em>empty</em> : variable.value}
              </span>
              {canWrite && (
                <>
                  <button type="button" className="icon-button" onClick={() => edit(variable)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    onClick={() => void remove(variable)}
                  >
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && <ImportFile projectId={projectId} onImported={() => void load()} />}
    </section>
  );
}

/**
 * Many at once, from a `.env` file.
 *
 * Shows what will happen before anything does. The same parser runs here and on
 * the server, so the preview is what the server will read — a preview from a
 * different parser would be a promise the import did not keep.
 *
 * Asks where the values go. A real `.env` usually has credentials in it, and
 * importing those as ordinary variables would put them on this page and in an
 * endpoint's response; the default is secrets for that reason.
 */
function ImportFile({
  projectId,
  onImported,
}: {
  projectId: string;
  onImported: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [as, setAs] = useState<'secrets' | 'variables'>('secrets');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportEnvironmentResponse | undefined>();
  const [error, setError] = useState<string | undefined>();

  if (!open) {
    return (
      <div className="project-section__actions">
        <button type="button" className="button-quiet" onClick={() => setOpen(true)}>
          Import from a .env file
        </button>
      </div>
    );
  }

  const preview = parseDotenv(text);

  return (
    <div className="project-section__form">
      <label className="field">
        <span>Paste the contents of a .env file</span>
        <textarea
          className="input"
          rows={6}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setResult(undefined);
          }}
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span>Store them as</span>
        <select
          className="input"
          value={as}
          onChange={(event) => setAs(event.target.value as 'secrets' | 'variables')}
        >
          <option value="secrets">Secrets — never shown again</option>
          <option value="variables">Variables — shown on this page</option>
        </select>
      </label>

      {text.trim() !== '' && (
        <p className="project-section__hint">
          {preview.entries.length} to set
          {preview.entries.length > 0 ? `: ${preview.entries.map((e) => e.key).join(', ')}` : ''}
          {preview.problems.length > 0
            ? ` · ${preview.problems.length} line(s) will be skipped`
            : ''}
        </p>
      )}

      {result && (
        <>
          <p className="project-section__note">
            {result.applied.length} set
            {result.applied.length ? `: ${result.applied.join(', ')}` : ''}.
          </p>
          {result.refused.map((refused) => (
            <p key={`${refused.line}`} className="project-section__error">
              Line {refused.line}
              {refused.key ? ` (${refused.key})` : ''}: {refused.reason}
            </p>
          ))}
        </>
      )}
      {error && <p className="project-section__error">{error}</p>}

      <div className="project-section__actions">
        <button
          type="button"
          className="button-primary"
          disabled={busy || preview.entries.length === 0}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            importEnvironment(projectId, { text, as })
              .then((answer) => {
                setResult(answer);
                onImported();
              })
              .catch((cause: unknown) => {
                setError(
                  cause instanceof ApiError ? cause.message : 'The file could not be imported.',
                );
              })
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Importing…' : `Import ${preview.entries.length}`}
        </button>
        <button type="button" className="button-quiet" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
    </div>
  );
}
