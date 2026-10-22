import { useRef, useState, type FormEvent, type ReactElement, type Ref } from 'react';
import { Link } from 'react-router-dom';
import { roleHasPermission, type ProjectRole } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { canManage } from '../../lib/permissions.js';
import {
  createPreviewShare,
  fetchPreviewShares,
  revokePreviewShare,
} from '../../lib/preview-api.js';
import { addProjectMember, listProjectMembers } from '../../lib/projects-api.js';
import { useAction } from '../../lib/use-action.js';
import { useResource } from '../../lib/use-resource.js';
import {
  Button,
  Callout,
  ConfirmDialog,
  CopyButton,
  Dialog,
  Input,
  Popover,
  RelativeTime,
  Select,
  Skeleton,
  toast,
} from '../../ui/index.js';
import { RocketLaunch, ShareNetwork } from '../../ui/icons.js';
import type { ShareSection } from './workspace-actions.js';

/**
 * Share, Invite and Deploy in one place in the workspace (design spec 6.4).
 * Three rows: invite people, make a preview link, and a link to deploying.
 * Deploy is deliberately a link and never a button here: deploying is a
 * settings action with a build log.
 */

const DURATIONS = [
  { value: '1', label: '1 hour' },
  { value: '24', label: '1 day' },
  { value: '168', label: '1 week' },
];

export interface ShareProps {
  projectId: string;
  role: ProjectRole;
  /** Opens at this section (the preview's Share) rather than at Invite. */
  section?: ShareSection | undefined;
}

function describeError(error: Error): string {
  return error instanceof ApiError ? error.message : 'The request could not be completed.';
}

/** The popover for the desktop toolbar. Controlled when the frame needs to open it (the palette's "Invite people"). */
export function SharePopover({
  projectId,
  role,
  section,
  open: controlledOpen,
  onOpenChange,
}: ShareProps & { open?: boolean; onOpenChange?: (open: boolean) => void }): ReactElement {
  const [ownOpen, setOwnOpen] = useState(false);
  const previewLink = useRef<HTMLElement>(null);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean): void => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title="Share"
      align="end"
      className="share-popover"
      initialFocus={section === 'preview-link' ? previewLink : undefined}
      trigger={
        <Button variant="ghost" size="sm" icon={ShareNetwork} className="ws-toolbar__share">
          Share
        </Button>
      }
    >
      {open ? (
        <ShareContent projectId={projectId} role={role} previewLinkRef={previewLink} />
      ) : null}
    </Popover>
  );
}

/** The same content as a sheet, for the phone's overflow menu. */
export function ShareDialog({
  projectId,
  role,
  section,
  open,
  onOpenChange,
}: ShareProps & { open: boolean; onOpenChange: (open: boolean) => void }): ReactElement {
  const previewLink = useRef<HTMLElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Share"
      size="sm"
      {...(section === 'preview-link' ? { initialFocus: previewLink } : {})}
    >
      {open ? (
        <ShareContent projectId={projectId} role={role} previewLinkRef={previewLink} />
      ) : null}
    </Dialog>
  );
}

export function ShareContent({
  projectId,
  role,
  previewLinkRef,
}: ShareProps & {
  /** The preview link section, focusable so Share can open straight to it. */
  previewLinkRef?: Ref<HTMLElement>;
}): ReactElement {
  const settings = `/projects/${projectId}/settings`;
  return (
    <div className="share">
      <section className="share__section" aria-labelledby="share-invite">
        <h3 id="share-invite" className="share__heading">
          Invite people
        </h3>
        {canManage(role) ? (
          <InviteForm projectId={projectId} />
        ) : (
          <MembersList projectId={projectId} peoplePath={`${settings}/people`} />
        )}
      </section>

      <section
        ref={previewLinkRef}
        className="share__section"
        aria-labelledby="share-link"
        tabIndex={-1}
      >
        <h3 id="share-link" className="share__heading">
          Preview link
        </h3>
        {roleHasPermission(role, 'deployment:control') ? (
          <PreviewLinks projectId={projectId} />
        ) : (
          <p className="share__hint">Only the project owner can make preview links.</p>
        )}
      </section>

      <section className="share__section" aria-labelledby="share-deploy">
        <h3 id="share-deploy" className="share__heading">
          Deploy
        </h3>
        <p className="share__hint">
          Give this project a Live URL that stays up after you close the workspace.
        </p>
        <Button variant="link" size="sm" icon={RocketLaunch} asChild>
          <Link to={`${settings}/deploy`}>Deploy this project</Link>
        </Button>
      </section>
    </div>
  );
}

function InviteForm({ projectId }: { projectId: string }): ReactElement {
  const [username, setUsername] = useState('');
  const [inviteRole, setInviteRole] = useState<ProjectRole>('EDITOR');
  const [problem, setProblem] = useState<string | undefined>();
  const invite = useAction((name: string, asRole: ProjectRole) =>
    addProjectMember(projectId, { username: name, role: asRole }),
  );

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const name = username.trim();
    if (!name) {
      setProblem('Enter a username.');
      return;
    }
    setProblem(undefined);
    const outcome = await invite.run(name, inviteRole);
    if (outcome.ok) {
      toast({ tone: 'success', title: `${name} added as ${roleWord(inviteRole)}` });
      setUsername('');
    } else {
      setProblem(describeError(outcome.error));
    }
  };

  return (
    <form className="share__form" onSubmit={(event) => void submit(event)}>
      <label className="share__field">
        <span className="share__label">Username</span>
        <Input
          size="sm"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="off"
          invalid={problem !== undefined}
        />
      </label>
      <label className="share__field share__field--narrow">
        <span className="share__label">Role</span>
        <Select
          size="sm"
          value={inviteRole}
          onValueChange={(value) => setInviteRole(value as ProjectRole)}
          options={[
            { value: 'EDITOR', label: 'Editor' },
            { value: 'VIEWER', label: 'Viewer' },
          ]}
        />
      </label>
      <Button type="submit" size="sm" loading={invite.busy}>
        Add to project
      </Button>
      {problem ? (
        <p className="share__error" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

function MembersList({
  projectId,
  peoplePath,
}: {
  projectId: string;
  peoplePath: string;
}): ReactElement {
  const members = useResource((signal) => listProjectMembers(projectId, signal), [projectId]);
  if (members.status === 'loading') return <Skeleton lines={2} />;
  if (members.status === 'error' || !members.data) {
    return (
      <Callout
        tone="danger"
        title="Could not read who has access."
        action={
          <Button size="sm" onClick={members.reload}>
            Retry
          </Button>
        }
      />
    );
  }
  return (
    <>
      <ul className="share__members">
        {members.data.members.map((member) => (
          <li key={member.userId} className="share__member">
            <span>{member.displayName || member.username}</span>
            <span className="share__member-role">{roleWord(member.role)}</span>
          </li>
        ))}
      </ul>
      <p className="share__hint">
        Only the project owner can invite people. <Link to={peoplePath}>See People</Link>
      </p>
    </>
  );
}

function PreviewLinks({ projectId }: { projectId: string }): ReactElement {
  const [hours, setHours] = useState('1');
  const [minted, setMinted] = useState<string | undefined>();
  const [revoking, setRevoking] = useState<string | undefined>();
  const shares = useResource((signal) => fetchPreviewShares(projectId, signal), [projectId]);
  const make = useAction((duration: number) => createPreviewShare(projectId, { hours: duration }));

  const onMake = async (): Promise<void> => {
    const outcome = await make.run(Number(hours));
    if (outcome.ok) {
      setMinted(outcome.value.url);
      shares.reload();
    } else {
      toast({
        tone: 'danger',
        title: 'Could not make the link',
        description: describeError(outcome.error),
      });
    }
  };

  const active = (shares.data ?? []).filter((share) => share.revokedAt === null);

  return (
    <div className="share__links">
      <div className="share__form">
        <label className="share__field share__field--narrow">
          <span className="share__label">Works for</span>
          <Select size="sm" value={hours} onValueChange={setHours} options={DURATIONS} />
        </label>
        <Button size="sm" loading={make.busy} onClick={() => void onMake()}>
          Make link
        </Button>
      </div>

      {minted ? (
        <Callout tone="ok" title="Copy this now. It will not be shown again.">
          <div className="share__minted">
            <Input size="sm" mono readOnly value={minted} aria-label="Preview link" />
            <CopyButton value={minted} label="Copy preview link" size="sm" />
          </div>
        </Callout>
      ) : null}

      {shares.status === 'loading' ? (
        <Skeleton lines={2} />
      ) : shares.status === 'error' ? (
        <Callout
          tone="danger"
          title="Could not read the preview links."
          action={
            <Button size="sm" onClick={shares.reload}>
              Retry
            </Button>
          }
        />
      ) : active.length === 0 ? (
        <p className="share__hint">
          No active preview links. A link shows the running app to anyone who has it, for a limited
          time.
        </p>
      ) : (
        <ul className="share__members">
          {active.map((share) => (
            <li key={share.id} className="share__member">
              <span>
                {share.label || 'Preview link'}
                <span className="share__member-role">
                  {' '}
                  expires <RelativeTime value={share.expiresAt} />
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRevoking(share.id)}
                aria-label={`Revoke link for ${share.label || 'preview'}`}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(next) => {
          if (!next) setRevoking(undefined);
        }}
        title="Revoke this link?"
        body="Anyone using it loses access now."
        confirmLabel="Revoke link"
        tone="danger"
        onConfirm={async () => {
          if (!revoking) return;
          await revokePreviewShare(projectId, revoking);
          setRevoking(undefined);
          shares.reload();
        }}
      />
    </div>
  );
}

function roleWord(role: ProjectRole): string {
  return role === 'OWNER' ? 'Owner' : role === 'EDITOR' ? 'Editor' : 'Viewer';
}
