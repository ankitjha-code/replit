import { useCallback, useEffect, useState } from 'react';
import type { PreviewShare } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { createPreviewShare, fetchPreviewShares, revokePreviewShare } from '../lib/preview-api.js';

/**
 * Links that show the running preview to somebody without an account.
 *
 * The address is shown once, straight after it is made, because the server
 * keeps only its hash: a list that could show it again would mean the server
 * was keeping the link itself. Revoking a link ends every viewing it handed
 * out, not just future ones, and the page says so.
 */
export function ProjectPreviewShares({ projectId }: { projectId: string }): React.JSX.Element {
  const [shares, setShares] = useState<PreviewShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [hours, setHours] = useState('24');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<string | undefined>();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const listed = await fetchPreviewShares(projectId, signal);
        if (signal?.aborted) return;
        setShares(listed);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'Share links could not be loaded.');
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

  const create = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setCreated(undefined);

    try {
      const trimmed = label.trim();
      const { url } = await createPreviewShare(projectId, {
        hours: Number(hours),
        ...(trimmed ? { label: trimmed } : {}),
      });
      setCreated(url);
      setLabel('');
      await load();
    } catch (cause) {
      const { fields, message } = fieldErrorsFrom(cause);
      setError(
        fields.hours ??
          fields.label ??
          message ??
          (cause instanceof ApiError ? cause.message : 'The link could not be made.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (share: PreviewShare): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await revokePreviewShare(projectId, share.id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That link could not be turned off.');
    } finally {
      setBusy(false);
    }
  };

  const now = Date.now();
  const live = shares.filter((share) => !share.revokedAt && Date.parse(share.expiresAt) > now);

  return (
    <section className="project-section" aria-labelledby="preview-shares-heading">
      <h2 id="preview-shares-heading">Share the preview</h2>
      <p className="project-section__hint">
        A link that opens this project&apos;s running preview for anybody who has it, with no
        account needed. It shows whatever is running at the time, and only while it is running. For
        something that stays up, deploy instead.
      </p>

      <form className="project-section__form" onSubmit={(event) => void create(event)}>
        <label htmlFor="share-hours">Works for</label>
        <select id="share-hours" value={hours} onChange={(event) => setHours(event.target.value)}>
          <option value="1">1 hour</option>
          <option value="24">1 day</option>
          <option value="72">3 days</option>
          <option value="168">1 week</option>
        </select>
        <label htmlFor="share-label">Note (optional)</label>
        <input
          id="share-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Who it is for"
          maxLength={100}
          autoComplete="off"
        />
        <button type="submit" className="button-quiet" disabled={busy}>
          {busy ? 'Making…' : 'Make link'}
        </button>
      </form>

      {created && (
        <div className="project-section__note" role="status">
          <p>Copy this now. It will not be shown again.</p>
          <input
            aria-label="New share link"
            readOnly
            value={created}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="project-section__note">Loading share links…</p>}

      {!loading && live.length === 0 && (
        <p className="project-section__note">No links are working right now.</p>
      )}

      {live.length > 0 && (
        <ul className="project-section__list">
          {live.map((share) => (
            <li key={share.id} className="project-section__item">
              <span className="project-section__item-name">{share.label ?? 'Untitled link'}</span>
              <span className="project-section__item-meta">
                until {new Date(share.expiresAt).toLocaleString()}
                {share.createdBy ? `, made by ${share.createdBy}` : ''}
              </span>
              <button
                type="button"
                className="icon-button"
                disabled={busy}
                onClick={() => void revoke(share)}
              >
                Turn off
              </button>
            </li>
          ))}
        </ul>
      )}

      {live.length > 0 && (
        <p className="project-section__note">
          Turning a link off also closes the preview for everybody already looking through it.
        </p>
      )}
    </section>
  );
}
