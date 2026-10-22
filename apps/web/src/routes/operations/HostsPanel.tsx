import { useState } from 'react';
import type { OperationsHost } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { formatBytes } from '../../lib/format.js';
import { fetchHosts, setHostDrain } from '../../lib/operations-api.js';
import { useResource } from '../../lib/use-resource.js';
import { HardDrives } from '../../ui/icons.js';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Meter,
  SectionHeader,
  Table,
  toast,
  type TableColumn,
} from '../../ui/index.js';
import { usePatched } from './use-patched.js';

export function HostsPanel(): React.JSX.Element {
  const list = useResource((signal) => fetchHosts(signal), []);
  const [hosts, setHosts] = usePatched(list.data);
  const rows = hosts ?? [];
  const canDrain = rows.length > 1;
  const [confirming, setConfirming] = useState<OperationsHost | undefined>();

  const errorMessage =
    list.status === 'error'
      ? list.error instanceof ApiError
        ? list.error.message
        : 'The hosts could not be loaded.'
      : undefined;

  const reasons = [...new Set(rows.map((host) => host.reason).filter(Boolean))] as string[];

  const columns: TableColumn<OperationsHost>[] = [
    {
      key: 'host',
      header: 'Host',
      mono: true,
      cell: (host) => host.name,
    },
    {
      key: 'capacity',
      header: 'Capacity',
      width: '32%',
      cell: (host) => (
        <Meter
          className="hosts__meter"
          label={`Environments on ${host.name}`}
          value={host.workloads.used}
          max={host.workloads.declared}
          format={(value) => `${value} of ${host.workloads.declared}`}
        />
      ),
    },
    {
      key: 'resources',
      header: 'CPU and memory',
      cell: (host) => (
        <span className="hosts__resources">
          <span>
            {formatCores(host.cpuMillicores.used)} of {formatCores(host.cpuMillicores.declared)}{' '}
            cores
          </span>
          <span>
            {formatBytes(host.memoryMb.used * 1024 * 1024)} of{' '}
            {formatBytes(host.memoryMb.declared * 1024 * 1024)}
          </span>
        </span>
      ),
    },
    {
      key: 'placing',
      header: 'Placement',
      width: '120px',
      cell: (host) =>
        host.draining ? (
          <Badge tone="warn">Draining</Badge>
        ) : host.schedulable ? (
          <Badge tone="ok">Placing</Badge>
        ) : (
          <Badge tone="danger">Not placing</Badge>
        ),
    },
  ];

  if (canDrain) {
    columns.push({
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      align: 'end',
      width: '1%',
      cell: (host) => (
        <Button
          size="sm"
          aria-label={host.draining ? `Resume placing work on ${host.name}` : `Drain ${host.name}`}
          onClick={() => setConfirming(host)}
        >
          {host.draining ? 'Resume placing work' : 'Drain'}
        </Button>
      ),
    });
  }

  return (
    <section className="operations-section" aria-labelledby="hosts-heading">
      <SectionHeader
        id="hosts-heading"
        title="Hosts"
        description="The machines environments run on, against the capacity each was given."
        {...(hosts ? { count: rows.length } : {})}
      />

      {reasons.map((reason) => (
        <Callout key={reason} tone="warn" title={reason} />
      ))}

      <Table
        caption="Execution hosts"
        columns={columns}
        rows={rows}
        rowKey={(host) => host.name}
        loading={list.status === 'loading'}
        {...(errorMessage ? { error: errorMessage, onRetry: list.reload } : {})}
        empty={{
          icon: HardDrives,
          title: 'No hosts yet.',
          body: 'Hosts appear here once an execution backend is configured for this installation.',
        }}
      />

      <ConfirmDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        tone={confirming?.draining ? 'default' : 'danger'}
        title={
          confirming
            ? confirming.draining
              ? `Resume placing work on ${confirming.name}?`
              : `Drain ${confirming.name}?`
            : ''
        }
        body={
          confirming?.draining
            ? 'New environments may be placed on this host again.'
            : 'Nothing new is placed on this host. What is already running there keeps running, and moves to another host the next time it is started.'
        }
        confirmLabel={
          confirming?.draining ? 'Resume placing work' : `Drain ${confirming?.name ?? 'host'}`
        }
        onConfirm={async () => {
          if (!confirming) return;
          const draining = !confirming.draining;
          setHosts(await setHostDrain(confirming.name, draining));
          toast({
            tone: 'success',
            title: draining
              ? `${confirming.name} is draining`
              : `${confirming.name} is placing work again`,
          });
        }}
      />
    </section>
  );
}

function formatCores(millicores: number): string {
  const cores = millicores / 1000;
  return Number.isInteger(cores) ? String(cores) : cores.toFixed(1);
}
