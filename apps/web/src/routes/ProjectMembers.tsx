import { useCallback, useEffect, useState } from 'react';
import { PROJECT_ROLES, type ProjectMemberView, type ProjectRole } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import {
  addProjectMember,
  leaveProject,
  listProjectMembers,
  removeProjectMember,
  setProjectMemberRole,
} from '../lib/projects-api.js';

/**
 * Who can reach this project.
 *
 * Everything built in this phase assumed a project could hold more than one
 * person, and until now nothing could put one there. This is the page that
 * makes presence, live events and shared editing describe something that can
 * actually happen.
 *
 * People are added by username. It is the only thing about another account this
 * platform ever shows, and the only thing somebody can reasonably be expected
 * to know; an identifier here would imply a way to look one up.
 */
export function ProjectMembers({
  projectId,
  currentUserId,
  canManage,
  onLeft,
}: {
  projectId: string;
  /** So the list can mark one row as yours and offer the right control on it. */
  currentUserId: string | undefined;
  canManage: boolean;
  /** Called after leaving, so the page can send the person somewhere they can see. */
  onLeft: () => void;
}): React.JSX.Element {
  const [members, setMembers] = useState<ProjectMemberView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<ProjectRole>('EDITOR');
  const [confirming, setConfirming] = useState<string | undefined>();
  const [leaving, setLeaving] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const listed = await listProjectMembers(projectId, signal);
        if (signal?.aborted) return;
        setMembers(listed.members);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The members could not be loaded.');
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

  const add = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      await addProjectMember(projectId, { username, role });
      setUsername('');
      await load();
    } catch (cause) {
      const { fields, message } = fieldErrorsFrom(cause);
      setError(
        fields.username ??
          message ??
          (cause instanceof ApiError ? cause.message : 'That person could not be added.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: ProjectMemberView, next: ProjectRole): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await setProjectMemberRole(projectId, member.userId, next);
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "That person's access could not be changed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member: ProjectMemberView): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setConfirming(undefined);
    try {
      await removeProjectMember(projectId, member.userId);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That person could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  const leave = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setLeaving(false);
    try {
      await leaveProject(projectId);
      onLeft();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'You could not leave this project.');
      setBusy(false);
    }
  };

  const mine = members.find((member) => member.userId === currentUserId);

  return (
    <section className="project-section" aria-labelledby="members-heading">
      <h2 id="members-heading">People</h2>
      <p className="project-section__hint">
        Everyone here can open this project. An editor can change its files, run it and open a
        terminal in it; an owner can also read its secrets and its database credentials, and delete
        it. A viewer can look and nothing more.
      </p>

      {canManage && (
        <form className="project-section__form" onSubmit={(event) => void add(event)}>
          <label htmlFor="member-username">Username</label>
          <input
            id="member-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Their username"
            autoComplete="off"
            required
          />

          <label htmlFor="member-role">Access</label>
          <select
            id="member-role"
            value={role}
            onChange={(event) => setRole(event.target.value as ProjectRole)}
          >
            {PROJECT_ROLES.map((value) => (
              <option key={value} value={value}>
                {roleLabel(value)}
              </option>
            ))}
          </select>

          <button type="submit" className="button-quiet" disabled={busy}>
            {busy ? 'Adding…' : 'Add to project'}
          </button>
        </form>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="project-section__note">Loading people…</p>}

      {members.length > 0 && (
        <ul className="project-section__list">
          {members.map((member) => {
            const self = member.userId === currentUserId;

            return (
              <li key={member.userId} className="project-section__item">
                <span className="project-section__item-name">
                  {member.displayName ?? member.username}
                  {self ? ' (you)' : ''}
                </span>
                <span className="project-section__item-meta">@{member.username}</span>
                <span className="project-section__item-meta">
                  Joined {new Date(member.joinedAt).toLocaleDateString()}
                </span>

                {/* Your own access is shown and not editable, here or on the
                    server: somebody demoting themselves in a project where they
                    are the only owner would leave it with nobody who can
                    administer it. */}
                {canManage && !self ? (
                  <select
                    aria-label={`Access for ${member.username}`}
                    value={member.role}
                    disabled={busy}
                    onChange={(event) => void changeRole(member, event.target.value as ProjectRole)}
                  >
                    {PROJECT_ROLES.map((value) => (
                      <option key={value} value={value}>
                        {roleLabel(value)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="project-section__item-value">{roleLabel(member.role)}</span>
                )}

                {canManage &&
                  !self &&
                  (confirming === member.userId ? (
                    <>
                      <button
                        type="button"
                        className="button-danger"
                        disabled={busy}
                        onClick={() => void remove(member)}
                      >
                        Yes, remove them
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => setConfirming(undefined)}
                      >
                        Keep them
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="icon-button"
                      disabled={busy}
                      onClick={() => setConfirming(member.userId)}
                    >
                      Remove
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}

      {/* Leaving is not an administrative act, so it is offered to everybody
          who is in the project rather than only to people who can manage it. */}
      {mine && (
        <div className="project-section__actions">
          {leaving ? (
            <>
              <p className="project-section__note">
                You will lose access to this project. Somebody still in it can add you back.
              </p>
              <button
                type="button"
                className="button-danger"
                disabled={busy}
                onClick={() => void leave()}
              >
                Yes, leave this project
              </button>
              <button type="button" className="icon-button" onClick={() => setLeaving(false)}>
                Stay
              </button>
            </>
          ) : (
            <button type="button" className="icon-button" onClick={() => setLeaving(true)}>
              Leave this project
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** A role in the words the page uses, rather than the enum's. */
function roleLabel(role: ProjectRole): string {
  switch (role) {
    case 'OWNER':
      return 'Owner';
    case 'EDITOR':
      return 'Editor';
    case 'VIEWER':
      return 'Viewer';
  }
}
