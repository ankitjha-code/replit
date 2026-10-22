import { useState, type ReactElement, type ReactNode } from 'react';
import { useTheme } from '../theme/use-theme.js';
import { Field } from '../components/Field.js';
import { Avatar, AvatarGroup } from './Avatar/Avatar.js';
import { Badge, StatusPill } from './Badge/Badge.js';
import { Banner } from './Banner/Banner.js';
import { Breadcrumb } from './Breadcrumb/Breadcrumb.js';
import { Button } from './Button/Button.js';
import { Callout } from './Callout/Callout.js';
import { Card } from './Card/Card.js';
import { Checkbox } from './Checkbox/Checkbox.js';
import { CodeBlock } from './CodeBlock/CodeBlock.js';
import { CommandPalette } from './CommandPalette/CommandPalette.js';
import { ConfirmDialog } from './ConfirmDialog/ConfirmDialog.js';
import { CopyButton } from './CopyButton/CopyButton.js';
import { Dialog } from './Dialog/Dialog.js';
import { EmptyState } from './EmptyState/EmptyState.js';
import { FormGrid, FormRow } from './Form/Form.js';
import { IconButton } from './IconButton/IconButton.js';
import { Input } from './Input/Input.js';
import { Kbd } from './Kbd/Kbd.js';
import { KeyValue } from './KeyValue/KeyValue.js';
import { ListRow } from './ListRow/ListRow.js';
import { ContextMenu } from './Menu/ContextMenu.js';
import { Menu } from './Menu/Menu.js';
import { Meter } from './Meter/Meter.js';
import { PageHeader } from './PageHeader/PageHeader.js';
import { Popover } from './Popover/Popover.js';
import { Progress } from './Progress/Progress.js';
import { RelativeTime } from './RelativeTime/RelativeTime.js';
import { RowActions } from './RowActions/RowActions.js';
import { SecretValue } from './SecretValue/SecretValue.js';
import { SectionHeader } from './SectionHeader/SectionHeader.js';
import { SegmentedControl } from './SegmentedControl/SegmentedControl.js';
import { Select } from './Select/Select.js';
import { Skeleton } from './Skeleton/Skeleton.js';
import { Spinner } from './Spinner/Spinner.js';
import { StatTile } from './StatTile/StatTile.js';
import { StatusDot } from './StatusDot/StatusDot.js';
import { Switch } from './Switch/Switch.js';
import { Table } from './Table/Table.js';
import { TabPanel, Tabs } from './Tabs/Tabs.js';
import { Textarea } from './Textarea/Textarea.js';
import { useToast } from './Toast/Toast.js';
import { Tooltip } from './Tooltip/Tooltip.js';
import {
  ArrowClockwise,
  Browser,
  FolderSimple,
  ListDashes,
  Monitor,
  Moon,
  PencilSimple,
  Play,
  RocketLaunch,
  Sun,
  TerminalWindow,
  Trash,
  Users,
} from './icons.js';
import './Gallery.css';

export const GALLERY_SECTIONS = [
  'Button',
  'IconButton',
  'Input',
  'Textarea',
  'Select',
  'Checkbox',
  'Switch',
  'Field',
  'FormRow',
  'Tabs',
  'Dialog',
  'ConfirmDialog',
  'Menu',
  'ContextMenu',
  'Tooltip',
  'Popover',
  'Toast',
  'Callout',
  'Banner',
  'EmptyState',
  'Skeleton',
  'Spinner',
  'Badge',
  'StatusDot',
  'Avatar',
  'Table',
  'ListRow',
  'RowActions',
  'KeyValue',
  'Card',
  'PageHeader',
  'SectionHeader',
  'Breadcrumb',
  'CopyButton',
  'CodeBlock',
  'SecretValue',
  'Kbd',
  'Meter',
  'StatTile',
  'RelativeTime',
  'SegmentedControl',
  'Progress',
  'CommandPalette',
] as const;

function Section({ name, children }: { name: string; children: ReactNode }): ReactElement {
  return (
    <section className="ui-gallery__section" aria-labelledby={`gallery-${name}`}>
      <h2 id={`gallery-${name}`} className="ui-gallery__title">
        {name}
      </h2>
      <div className="ui-gallery__body">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="ui-gallery__row">
      <span className="ui-gallery__label">{label}</span>
      <div className="ui-gallery__cells">{children}</div>
    </div>
  );
}

const noop = (): void => {};
const reject = (): Promise<void> => Promise.reject(new Error('The server said no.'));

interface Member {
  id: string;
  name: string;
  role: string;
}

const members: Member[] = [
  { id: '1', name: 'alice', role: 'Owner' },
  { id: '2', name: 'bob', role: 'Editor' },
];

const memberColumns = [
  { key: 'name', header: 'Name', cell: (row: Member) => row.name },
  { key: 'role', header: 'Role', cell: (row: Member) => row.role },
];

const memberEmpty = {
  icon: Users,
  title: 'No members yet',
  body: 'Invite someone and they appear here.',
};

export function Gallery(): ReactElement {
  const { preference, setPreference } = useTheme();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tab, setTab] = useState('output');
  const [segment, setSegment] = useState('editor');
  const [switchOn, setSwitchOn] = useState(true);

  return (
    <div className="ui-gallery">
      <header className="ui-gallery__header">
        <h1 className="ui-gallery__h1">Primitives</h1>
        <SegmentedControl
          label="Theme"
          value={preference}
          onValueChange={(value) => setPreference(value as 'system' | 'dark' | 'light')}
          items={[
            { value: 'system', label: 'System', icon: Monitor },
            { value: 'dark', label: 'Dark', icon: Moon },
            { value: 'light', label: 'Light', icon: Sun },
          ]}
        />
      </header>

      <Section name="Button">
        <Row label="Variants">
          <Button variant="primary" icon={Play}>
            Start
          </Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon={Trash}>
            Delete project
          </Button>
          <Button variant="link">Link</Button>
        </Row>
        <Row label="Sizes">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </Row>
        <Row label="Loading">
          <Button variant="primary" icon={Play} loading loadingLabel="Starting">
            Start
          </Button>
          <Button loading>Saving</Button>
        </Row>
        <Row label="Disabled with reason">
          <Button variant="primary" disabledReason="Start the environment first">
            Run
          </Button>
          <Button disabledReason="Only the owner can do this">Delete project</Button>
        </Row>
      </Section>

      <Section name="IconButton">
        <Row label="Variants">
          <IconButton label="Restart" icon={ArrowClockwise} shortcut={['Mod', 'Shift', 'R']} />
          <IconButton label="Rename" icon={PencilSimple} variant="secondary" />
          <IconButton label="Delete" icon={Trash} variant="danger" size="lg" />
          <IconButton label="Delete" icon={Trash} disabledReason="Read-only access" />
          <IconButton label="Saving" icon={Play} loading />
        </Row>
      </Section>

      <Section name="Input">
        <Row label="States">
          <Input aria-label="Rest" placeholder="Project name" />
          <Input aria-label="Invalid" invalid defaultValue="hello world" />
          <Input aria-label="Read only" readOnly defaultValue="read-only" />
          <Input
            aria-label="Disabled"
            disabledReason="Only the owner can rename"
            defaultValue="hello"
          />
          <Input
            aria-label="Mono"
            mono
            defaultValue="npm run dev"
            trailing={<CopyButton value="npm run dev" />}
          />
        </Row>
        <Row label="Sizes">
          <Input aria-label="Small" size="sm" placeholder="sm" />
          <Input aria-label="Medium" size="md" placeholder="md" />
          <Input aria-label="Large" size="lg" placeholder="lg" />
        </Row>
      </Section>

      <Section name="Textarea">
        <Row label="States">
          <Textarea aria-label="Rest" placeholder="Snapshot note" autoGrow />
          <Textarea aria-label="Invalid" invalid defaultValue="Too long" />
          <Textarea aria-label="Disabled" disabledReason="Read-only access" />
        </Row>
      </Section>

      <Section name="Select">
        <Row label="States">
          <Select
            aria-label="Works for"
            defaultValue="editor"
            options={[
              { value: 'viewer', label: 'Viewer' },
              { value: 'editor', label: 'Editor' },
            ]}
          />
          <Select aria-label="Invalid" invalid options={[{ value: 'a', label: 'Choose' }]} />
          <Select aria-label="Loading" loading options={[{ value: 'a', label: 'Saving' }]} />
          <Select
            aria-label="Disabled"
            disabledReason="Owners cannot change role"
            options={[{ value: 'owner', label: 'Owner' }]}
          />
        </Row>
      </Section>

      <Section name="Checkbox">
        <Row label="States">
          <Checkbox label="Email me" description="Once a day at most" defaultChecked />
          <Checkbox label="Select all" indeterminate />
          <Checkbox label="Alerts" disabledReason="Monitoring is off" />
          <Checkbox label="Saving" loading checked />
          <Checkbox label="Rejects" checked={false} onCheckedChange={reject} />
        </Row>
      </Section>

      <Section name="Switch">
        <Row label="States">
          <Switch
            label="Follow output"
            checked={switchOn}
            onCheckedChange={(next) => setSwitchOn(next)}
          />
          <Switch label="Keep measuring" description="Polls every 5 seconds" checked />
          <Switch label="Alerts" disabledReason="Monitoring is off" />
          <Switch label="Saving" loading checked />
          <Switch label="Rejects" checked={false} onCheckedChange={reject} />
        </Row>
      </Section>

      <Section name="Field">
        <div className="ui-gallery__form">
          <Field id="g-email" label="Email" value="" onChange={noop} hint="We never share it" />
          <Field id="g-name" label="Name" value="" onChange={noop} error="Enter a name" />
          <Field
            id="g-password"
            label="Password"
            as="password"
            value="hunter2"
            onChange={noop}
            action={<Button variant="link">Forgot?</Button>}
          />
          <Field id="g-note" label="Note" as="textarea" value="" onChange={noop} />
          <Field
            id="g-role"
            label="Role"
            as="select"
            value="editor"
            onChange={noop}
            options={[
              { value: 'viewer', label: 'Viewer' },
              { value: 'editor', label: 'Editor' },
            ]}
          />
          <Field
            id="g-locked"
            label="Slug"
            value="hello-world"
            mono
            disabledReason="Only the owner can rename"
          />
        </div>
      </Section>

      <Section name="FormRow">
        <FormGrid columns={2} actions={<Button variant="primary">Save</Button>}>
          <FormRow label="Name" htmlFor="g-row-name" hint="Shown to members">
            <Input id="g-row-name" />
          </FormRow>
          <FormRow label="Access" htmlFor="g-row-access">
            <Select id="g-row-access" options={[{ value: 'viewer', label: 'Viewer' }]} />
          </FormRow>
        </FormGrid>
      </Section>

      <Section name="Tabs">
        <Row label="Line">
          <Tabs
            label="Console"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: 'output', label: 'Output', icon: ListDashes, badge: 3 },
              { value: 'shell', label: 'Shell', icon: TerminalWindow },
              { value: 'logs', label: 'Logs', disabledReason: 'Start the environment first' },
            ]}
          >
            <TabPanel value="output">Output panel</TabPanel>
            <TabPanel value="shell">Shell panel</TabPanel>
          </Tabs>
        </Row>
        <Row label="Segmented">
          <Tabs
            label="Device"
            variant="segmented"
            defaultValue="desktop"
            items={[
              { value: 'desktop', label: 'Desktop' },
              { value: 'phone', label: 'Phone' },
            ]}
          />
        </Row>
      </Section>

      <Section name="Dialog">
        <Row label="Open">
          <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
        </Row>
        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="Rename project"
          description="The URL changes with it."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialogOpen(false)}>
                Rename
              </Button>
            </>
          }
        >
          <Field id="g-dialog-name" label="Name" value="hello-world" onChange={noop} />
        </Dialog>
      </Section>

      <Section name="ConfirmDialog">
        <Row label="Open">
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Delete project
          </Button>
        </Row>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Delete project?"
          body="Its files and deployments go with it."
          confirmLabel="Delete project"
          tone="danger"
          typeToConfirm="hello-world"
          onConfirm={reject}
        />
      </Section>

      <Section name="Menu">
        <Row label="Dropdown">
          <Menu
            trigger={<Button>Actions</Button>}
            items={[
              { label: 'Rename', icon: PencilSimple, shortcut: ['F2'], onSelect: noop },
              { label: 'Files', checked: true, onSelect: noop },
              {
                label: 'Delete',
                icon: Trash,
                tone: 'danger',
                disabledReason: 'Only the owner can delete',
              },
            ]}
            radio={{
              label: 'Theme',
              value: 'dark',
              onValueChange: noop,
              items: [
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ],
            }}
          />
        </Row>
      </Section>

      <Section name="ContextMenu">
        <ContextMenu
          items={[
            { label: 'New file', onSelect: noop },
            { label: 'New folder', onSelect: noop },
          ]}
        >
          <div className="ui-gallery__target">Right-click here</div>
        </ContextMenu>
      </Section>

      <Section name="Tooltip">
        <Row label="Hover or focus">
          <Tooltip content="Copy the URL" shortcut={['Mod', 'C']}>
            <Button>Hover me</Button>
          </Tooltip>
        </Row>
      </Section>

      <Section name="Popover">
        <Row label="States">
          <Popover trigger={<Button>Details</Button>} title="Environment">
            <p>node 22, 1 CPU, 1 GB</p>
          </Popover>
          <Popover trigger={<Button>Loading</Button>} title="Environment" loading />
          <Popover
            trigger={<Button>Error</Button>}
            title="Environment"
            error="Could not load events"
            onRetry={noop}
          />
        </Row>
      </Section>

      <Section name="Toast">
        <Row label="Raise">
          <Button onClick={() => toast({ tone: 'success', title: 'Saved' })}>Success</Button>
          <Button
            onClick={() =>
              toast({
                tone: 'info',
                title: 'Link copied',
                description: 'Anyone with it can view the preview.',
              })
            }
          >
            Info
          </Button>
          <Button onClick={() => toast({ tone: 'warn', title: 'Reconnecting' })}>Warn</Button>
          <Button
            onClick={() =>
              toast({
                tone: 'danger',
                title: 'Save failed',
                description: 'The server did not answer.',
                action: { label: 'Retry', onClick: noop },
              })
            }
          >
            Danger (persists)
          </Button>
        </Row>
      </Section>

      <Section name="Callout">
        <div className="ui-gallery__stack">
          <Callout tone="info" title="Not configured on this installation">
            Deployments need a registry. Ask an operator.
          </Callout>
          <Callout tone="warn">Your session ends in 5 minutes.</Callout>
          <Callout tone="danger" title="Save failed" action={<Button size="sm">Retry</Button>}>
            The server did not answer.
          </Callout>
          <Callout tone="ok" onDismiss={noop}>
            Deployed.
          </Callout>
        </div>
      </Section>

      <Section name="Banner">
        <div className="ui-gallery__stack">
          <Banner
            tone="offline"
            message="You are offline. Changes save when you reconnect."
            action={<Button size="sm">Retry now</Button>}
          />
          <Banner tone="warn" message="Reconnecting" />
          <Banner
            tone="danger"
            message="Your session ended."
            action={
              <Button size="sm" variant="primary">
                Sign in
              </Button>
            }
          />
          <Banner tone="info" message="You have read-only access to this project." />
        </div>
      </Section>

      <Section name="EmptyState">
        <Row label="Panel">
          <EmptyState
            icon={FolderSimple}
            title="No files yet"
            body="Create a file and it appears here."
            action={<Button variant="primary">New file</Button>}
          />
        </Row>
        <Row label="Page">
          <EmptyState
            size="page"
            icon={RocketLaunch}
            title="No deployments yet"
            body="Deploy once and every release is listed here."
            action={<Button variant="primary">Deploy</Button>}
            secondary={<Button variant="link">How deploys work</Button>}
          />
        </Row>
      </Section>

      <Section name="Skeleton">
        <Row label="Shapes">
          <Skeleton lines={3} width={240} />
          <Skeleton shape="row" width={240} />
          <Skeleton shape="card" width={160} />
          <Skeleton shape="circle" />
        </Row>
      </Section>

      <Section name="Spinner">
        <Row label="Sizes">
          <Spinner size={12} label="Loading" />
          <Spinner size={16} label="Starting the environment" labelVisible />
          <Spinner size={20} label="Deploying" labelVisible />
        </Row>
      </Section>

      <Section name="Badge">
        <Row label="Tones">
          <Badge>Draft</Badge>
          <Badge tone="ok">Running</Badge>
          <Badge tone="warn">Starting</Badge>
          <Badge tone="danger">Failed</Badge>
          <Badge tone="info">Live</Badge>
          <Badge tone="accent">Owner</Badge>
          <StatusPill tone="ok" dot>
            Live
          </StatusPill>
        </Row>
      </Section>

      <Section name="StatusDot">
        <Row label="Tones">
          <StatusDot tone="neutral" label="Stopped" />
          <StatusDot tone="warn" pulse label="Starting" />
          <StatusDot tone="ok" label="Running" />
          <StatusDot tone="danger" label="Failed" />
        </Row>
      </Section>

      <Section name="Avatar">
        <Row label="Sizes and groups">
          <Avatar name="Ada Lovelace" userId="u1" size={20} />
          <Avatar name="Ada Lovelace" userId="u1" />
          <Avatar name="Ada Lovelace" userId="u1" size={32} />
          <AvatarGroup people={['Ada', 'Bob', 'Cy', 'Di', 'Ed', 'Fay'].map((name) => ({ name }))} />
        </Row>
      </Section>

      <Section name="Table">
        <div className="ui-gallery__stack">
          <Table
            caption="Members"
            columns={memberColumns}
            rows={members}
            rowKey={(row) => row.id}
            rowName={(row) => row.name}
            rowActions={() => [{ label: 'Remove', icon: Trash, onSelect: noop, tone: 'danger' }]}
            empty={memberEmpty}
            pagination={{ count: 2, total: 12, onMore: noop }}
          />
          <Table
            caption="Members, loading"
            columns={memberColumns}
            rows={[]}
            rowKey={(row) => row.id}
            empty={memberEmpty}
            loading
          />
          <Table
            caption="Members, empty"
            columns={memberColumns}
            rows={[]}
            rowKey={(row) => row.id}
            empty={memberEmpty}
          />
          <Table
            caption="Members, error"
            columns={memberColumns}
            rows={[]}
            rowKey={(row) => row.id}
            empty={memberEmpty}
            error="Could not load members"
            onRetry={noop}
          />
        </div>
      </Section>

      <Section name="ListRow">
        <ul className="ui-gallery__list">
          <ListRow
            title="deploy-42"
            description="main at 1a2b3c"
            meta={<RelativeTime value={Date.now() - 180_000} />}
            badge={<Badge tone="ok">Live</Badge>}
            actions={
              <RowActions
                objectName="deploy-42"
                items={[{ label: 'Open', icon: Browser, onSelect: noop }]}
              />
            }
          />
          <ListRow
            title="deploy-41"
            description="main at 9f8e7d"
            meta="2 days ago"
            badge={<Badge tone="danger">Failed</Badge>}
            selected
            expanded={<CodeBlock code="npm ERR! missing script: build" label="Build log" />}
          />
        </ul>
      </Section>

      <Section name="RowActions">
        <Row label="Inline and overflow">
          <RowActions
            objectName="alice"
            items={[
              { label: 'Rename', icon: PencilSimple, onSelect: noop },
              {
                label: 'Remove',
                icon: Trash,
                tone: 'danger',
                disabledReason: 'You cannot remove the owner',
              },
            ]}
          />
          <RowActions
            objectName="deploy-42"
            items={[
              { label: 'Restart', icon: ArrowClockwise, onSelect: noop },
              { label: 'Rename', icon: PencilSimple, onSelect: noop },
              { label: 'Remove', icon: Trash, onSelect: noop },
            ]}
          />
        </Row>
      </Section>

      <Section name="KeyValue">
        <div className="ui-gallery__stack">
          <KeyValue
            items={[
              { term: 'Host', value: 'db.internal' },
              { term: 'Port', value: '5432', mono: true, copy: '5432' },
            ]}
          />
          <KeyValue items={[]} loading placeholderRows={2} />
          <KeyValue items={[]} error="Could not load facts" onRetry={noop} />
        </div>
      </Section>

      <Section name="Card">
        <Row label="Tones">
          <Card>Default</Card>
          <Card interactive as="a" href="#gallery-Card">
            Interactive
          </Card>
          <Card tone="danger">Danger zone</Card>
        </Row>
      </Section>

      <Section name="PageHeader">
        <PageHeader
          title="Hello World"
          description="A Node app."
          breadcrumb={
            <Breadcrumb items={[{ label: 'Projects', to: '/' }, { label: 'Hello World' }]} />
          }
          status={
            <StatusPill tone="ok" dot>
              Running
            </StatusPill>
          }
          primaryAction={
            <Button variant="primary" size="lg" icon={RocketLaunch}>
              Deploy
            </Button>
          }
          secondaryActions={[
            { label: 'Share', onSelect: noop },
            { label: 'Invite', onSelect: noop },
            { label: 'Archive', onSelect: noop },
          ]}
        />
      </Section>

      <Section name="SectionHeader">
        <div className="ui-gallery__stack">
          <SectionHeader
            title="People"
            icon={Users}
            count={3}
            description="Who can open this project."
            help={<p>Owners can do everything.</p>}
            action={<Button size="md">Invite</Button>}
          />
        </div>
      </Section>

      <Section name="Breadcrumb">
        <Breadcrumb
          items={[{ label: 'Projects', to: '/' }, { loading: true }, { label: 'Settings' }]}
        />
      </Section>

      <Section name="CopyButton">
        <Row label="Forms">
          <CopyButton value="https://example.test" label="Copy URL" />
          <CopyButton value="https://example.test" label="Copy URL" withText variant="secondary" />
        </Row>
      </Section>

      <Section name="CodeBlock">
        <CodeBlock
          code={'CNAME  app  example.test\nTXT    _verify  abc123'}
          label="DNS records"
          copy
        />
      </Section>

      <Section name="SecretValue">
        <Row label="States">
          <SecretValue value="hunter2" name="password" copy />
          <SecretValue value="" revealable={false} />
        </Row>
      </Section>

      <Section name="Kbd">
        <Row label="Keys">
          <Kbd keys={['Mod', 'K']} />
          <Kbd keys={['Mod', 'Shift', 'Enter']} />
          <Kbd keys={['Escape']} />
        </Row>
      </Section>

      <Section name="Meter">
        <div className="ui-gallery__stack">
          <Meter label="Memory" value={300} max={1000} format={(v) => `${v} MB`} />
          <Meter label="Memory" value={850} max={1000} format={(v) => `${v} MB`} />
          <Meter label="Memory" value={980} max={1000} format={(v) => `${v} MB`} />
          <Meter label="CPU" value={null} max={100} />
          <Meter label="Disk" value={null} max={100} loading />
        </div>
      </Section>

      <Section name="StatTile">
        <Row label="States">
          <StatTile label="Accounts" value={12} detail="of 100 allowed" to="/operations" />
          <StatTile label="Failed jobs" value={3} tone="danger" />
          <StatTile label="Hosts" loading />
          <StatTile label="Hosts" error="Could not load" onRetry={noop} />
        </Row>
      </Section>

      <Section name="RelativeTime">
        <Row label="Now and then">
          <RelativeTime value={Date.now() - 30_000} />
          <RelativeTime value={Date.now() - 3 * 3_600_000} prefix="Updated" />
          <RelativeTime value="not a date" />
        </Row>
      </Section>

      <Section name="SegmentedControl">
        <Row label="Phone switcher">
          <SegmentedControl
            label="Panel"
            value={segment}
            onValueChange={setSegment}
            items={[
              { value: 'files', label: 'Files', icon: FolderSimple },
              { value: 'editor', label: 'Editor' },
              {
                value: 'preview',
                label: 'Preview',
                icon: Browser,
                disabledReason: 'Nothing to preview',
              },
            ]}
          />
        </Row>
      </Section>

      <Section name="Progress">
        <div className="ui-gallery__stack">
          <Progress value={40} label="Pulling image" />
          <Progress label="Building" indeterminate />
        </div>
      </Section>

      <Section name="CommandPalette">
        <Row label="Open">
          <Button onClick={() => setPaletteOpen(true)} icon={Play}>
            Open palette
          </Button>
        </Row>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          commands={[
            {
              id: 'run',
              label: 'Run app',
              icon: Play,
              shortcut: ['Mod', 'Enter'],
              group: 'App',
              onSelect: noop,
            },
            {
              id: 'stop',
              label: 'Stop app',
              group: 'App',
              onSelect: noop,
              disabledReason: 'Nothing is running',
            },
            { id: 'theme', label: 'Theme: Light', group: 'Appearance', onSelect: noop },
          ]}
          recent={['theme']}
          files={{ status: 'ready', items: [{ path: 'src/index.ts' }, { path: 'README.md' }] }}
          onOpenFile={noop}
          onCreateFile={noop}
        />
      </Section>
    </div>
  );
}
