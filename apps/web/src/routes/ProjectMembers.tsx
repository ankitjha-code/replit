import { useRef, useState, type FormEvent } from 'react';
import {
  PROJECT_ROLES,
  roleHasPermission,
  type ProjectMemberView,
  type ProjectRole,
} from '@platform/shared';
import { Field } from '../components/Field.js';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import {
  addProjectMember,
  leaveProject,
  listProjectMembers,
  removeProjectMember,
  setProjectMemberRole,
} from '../lib/projects-api.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import { SignOut, Trash, UserPlus } from '../ui/icons.js';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Input,
  RelativeTime,
  SectionHeader,
  Select,
  Table,
  toast,
  type TableColumn,
} from '../ui/index.js';
import './ProjectMembers.css';

export function ProjectMembers({
  projectId,
  currentUserId,
  canManage,
  onLeft,
}: {
  projectId: string;
  currentUserId: string | undefined;
  canManage: boolean;
  onLeft: () => void;
}): React.JSX.Element {
  const list = useResource((signal) => listProjectMembers(projectId, signal), [projectId]);
  const members = list.data?.members ?? [];
  const mine = members.find((member) => member.userId === currentUserId);
  const [roleChange, setRoleChange] = useState<
    { member: ProjectMemberView; next: ProjectRole } | undefined
  >();
  const [removing, setRemoving] = useState<ProjectMemberView | undefined>();
  const [leaving, setLeaving] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  const onlyMe = members.length === 1 && mine !== undefined;
  const otherOwners = members.filter(
    (member) => member.role === 'OWNER' && member.userId !== currentUserId,
  );
  const leaveReason =
    mine?.role === 'OWNER' && otherOwners.length === 0
      ? 'You are the only owner. Make somebody else an owner first.'
      : undefined;

  const columns: TableColumn<ProjectMemberView>[] = [
    {
      key: 'person',
      header: 'Person',
      cell: (member) => {
        const self = member.userId === currentUserId;
        return (
          <span className="members__person">
            <Avatar name={member.displayName ?? member.username} userId={member.userId} />
            <span className="members__names">
              <span className="members__name">
                <span className="members__name-text" title={member.displayName ?? member.username}>
                  {member.displayName ?? member.username}
                </span>
                {self ? <Badge className="members__you">You</Badge> : null}
              </span>
              {member.displayName ? (
                <span className="members__username">@{member.username}</span>
              ) : null}
            </span>
          </span>
        );
      },
    },
    {
      key: 'role',
      header: 'Role',
      width: '160px',
      cell: (member) => {
        const self = member.userId === currentUserId;
        if (!canManage || self) return roleLabel(member.role);
        return (
          <Select
            size="md"
            aria-label={`Role of ${member.username}`}
            value={member.role}
            options={PROJECT_ROLES.map((value) => ({ value, label: roleLabel(value) }))}
            onChange={(event) => setRoleChange({ member, next: event.target.value as ProjectRole })}
          />
        );
      },
    },
    {
      key: 'joined',
      header: 'Joined',
      width: '140px',
      cell: (member) => <RelativeTime value={member.joinedAt} />,
    },
  ];

  const errorMessage =
    list.status === 'error'
      ? list.error instanceof ApiError
        ? list.error.message
        : 'The members could not be loaded.'
      : undefined;

  return (
    <>
      <SectionHeader
        title="Members"
        description="Everyone here can open this project."
        {...(list.data ? { count: members.length } : {})}
        help={
          <>
            <p>A viewer can look at files and output and nothing more.</p>
            <p>An editor can also change files, run the app and open a shell in it.</p>
            <p>
              An owner can also read secrets and database credentials, deploy, manage people and
              delete the project.
            </p>
          </>
        }
      />

      <Table
        caption="Members of this project"
        columns={columns}
        rows={onlyMe ? [] : members}
        rowKey={(member) => member.userId}
        loading={list.status === 'loading'}
        {...(errorMessage ? { error: errorMessage, onRetry: list.reload } : {})}
        rowName={(member) => member.username}
        rowActions={(member) =>
          canManage && member.userId !== currentUserId
            ? [
                {
                  label: 'Remove',
                  icon: Trash,
                  tone: 'danger',
                  onSelect: () => setRemoving(member),
                },
              ]
            : []
        }
        empty={{
          icon: UserPlus,
          title: 'Only you have access.',
          body: 'Invite people to work on this project with you.',
          ...(canManage
            ? {
                action: (
                  <Button variant="primary" onClick={() => usernameRef.current?.focus()}>
                    Invite people
                  </Button>
                ),
              }
            : {}),
        }}
      />

      {canManage ? (
        <InviteForm
          projectId={projectId}
          usernameRef={usernameRef}
          onAdded={(member) => {
            list.reload();
            toast({
              tone: 'success',
              title: `${member.username} added as ${roleLabel(member.role).toLowerCase()}`,
            });
          }}
        />
      ) : null}

      {mine ? (
        <div className="members__leave">
          <Button
            icon={SignOut}
            onClick={() => setLeaving(true)}
            {...(leaveReason ? { disabledReason: leaveReason } : {})}
          >
            Leave this project
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={roleChange !== undefined}
        onOpenChange={(open) => {
          if (!open) setRoleChange(undefined);
        }}
        title={
          roleChange
            ? `Change ${roleChange.member.username} to ${roleLabel(roleChange.next).toLowerCase()}?`
            : ''
        }
        body={roleChange ? describeRole(roleChange.next, roleChange.member.username) : undefined}
        confirmLabel="Change role"
        onConfirm={async () => {
          if (!roleChange) return;
          await setProjectMemberRole(projectId, roleChange.member.userId, roleChange.next);
          list.reload();
          toast({
            tone: 'success',
            title: `${roleChange.member.username} is now ${article(roleLabel(roleChange.next))}`,
          });
        }}
      />

      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        tone="danger"
        title={removing ? `Remove ${removing.username} from this project?` : ''}
        body="They lose access now. Somebody still in the project can add them back later."
        confirmLabel={removing ? `Remove ${removing.username}` : 'Remove'}
        onConfirm={async () => {
          if (!removing) return;
          await removeProjectMember(projectId, removing.userId);
          list.reload();
          toast({ tone: 'success', title: `${removing.username} removed` });
        }}
      />

      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        tone="danger"
        title="Leave this project?"
        body="You will lose access to this project. Somebody still in it can add you back."
        confirmLabel="Leave project"
        onConfirm={async () => {
          await leaveProject(projectId);
          onLeft();
        }}
      />
    </>
  );
}

function InviteForm({
  projectId,
  usernameRef,
  onAdded,
}: {
  projectId: string;
  usernameRef: React.RefObject<HTMLInputElement | null>;
  onAdded: (member: ProjectMemberView) => void;
}): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<ProjectRole>('EDITOR');
  const [usernameError, setUsernameError] = useState<string | undefined>();
  const add = useAction(() => addProjectMember(projectId, { username: username.trim(), role }));

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (username.trim() === '') {
      setUsernameError('Enter the username of the person to add');
      return;
    }
    setUsernameError(undefined);
    const outcome = await add.run();
    if (outcome.ok) {
      setUsername('');
      onAdded(outcome.value);
      return;
    }
    const { fields } = fieldErrorsFrom(outcome.error);
    const usernameMessage =
      fields.username ??
      (outcome.error instanceof ApiError && outcome.error.code === 'NOT_FOUND'
        ? outcome.error.message
        : undefined);
    if (usernameMessage) setUsernameError(usernameMessage);
  };

  const formError =
    add.error && !usernameError
      ? add.error instanceof ApiError
        ? (fieldErrorsFrom(add.error).message ?? add.error.message)
        : 'That person could not be added.'
      : undefined;

  return (
    <form className="members__invite" onSubmit={(event) => void onSubmit(event)} noValidate>
      <h3 className="members__invite-title">Invite people</h3>
      <div className="members__invite-fields">
        <Field id="member-username" label="Username" error={usernameError}>
          <Input
            ref={usernameRef}
            id="member-username"
            value={username}
            autoComplete="off"
            spellCheck={false}
            placeholder="Their username"
            invalid={Boolean(usernameError)}
            aria-describedby={usernameError ? 'member-username-error' : undefined}
            onChange={(event) => {
              setUsername(event.target.value);
              if (usernameError) setUsernameError(undefined);
              if (add.error) add.reset();
            }}
          />
        </Field>
        <Field
          id="member-role"
          label="Role"
          value={role}
          onChange={(event) => setRole(event.target.value as ProjectRole)}
          as="select"
          options={PROJECT_ROLES.map((value) => ({ value, label: roleLabel(value) }))}
          hint={describeRole(role)}
        />
      </div>
      {formError ? <Callout tone="danger" title={formError} /> : null}
      <div className="members__invite-actions">
        <Button type="submit" variant="secondary" icon={UserPlus} loading={add.busy}>
          Add to project
        </Button>
      </div>
    </form>
  );
}

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

function article(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word.toLowerCase()}`;
}

function describeRole(role: ProjectRole, who = 'They'): string {
  const can: string[] = [];
  if (roleHasPermission(role, 'file:write')) can.push('change files');
  if (roleHasPermission(role, 'runtime:control')) can.push('run the app');
  if (roleHasPermission(role, 'terminal:attach')) can.push('open a shell');
  if (roleHasPermission(role, 'secret:read')) can.push('read secrets and database credentials');
  if (roleHasPermission(role, 'deployment:control')) can.push('deploy');
  if (roleHasPermission(role, 'member:manage')) can.push('manage people');
  if (roleHasPermission(role, 'project:delete')) can.push('delete the project');
  if (can.length === 0) return `${who} can look at files and output and nothing more.`;
  const last = can.pop();
  return `${who} can ${can.length ? `${can.join(', ')} and ${last}` : last}.`;
}
