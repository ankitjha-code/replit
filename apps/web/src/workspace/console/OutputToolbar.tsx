import { useEffect, useRef } from 'react';
import { stripAnsi } from '../../lib/ansi.js';
import { copyText } from '../../lib/clipboard.js';
import { useGuardedNavigate } from '../../lib/navigation-guard.js';
import { settingsPath } from '../../routes/settings/pages.js';
import { Button, IconButton, Input, toast } from '../../ui/index.js';
import {
  Broom,
  CaretDown,
  CaretUp,
  Clock,
  Copy,
  MagnifyingGlass,
  Scroll,
  X,
} from '../../ui/icons.js';
import type { OutputLine } from './use-run.js';

/**
 * Tools for reading the output (design spec 9.6): search, copy, clear, wrap,
 * timestamps, and the way to the full log, which outlives this panel.
 */
export function OutputToolbar({
  projectId,
  lines,
  wrap,
  onWrapChange,
  timestamps,
  onTimestampsChange,
  searchOpen,
  onSearchOpenChange,
  onClear,
}: {
  projectId: string;
  lines: OutputLine[];
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
  timestamps: boolean;
  onTimestampsChange: (on: boolean) => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  onClear: () => void;
}): React.JSX.Element {
  const navigate = useGuardedNavigate();
  const empty = lines.length === 0;
  const nothing = 'There is no output yet.';

  const copyAll = async (): Promise<void> => {
    const text = lines
      .map((line) => (line.stream === 'system' ? `${line.data}\n` : stripAnsi(line.data)))
      .join('');
    const copied = await copyText(text);
    toast(
      copied
        ? { tone: 'success', title: 'Copied the output' }
        : { tone: 'danger', title: 'Could not copy. Select the text and copy it instead.' },
    );
  };

  return (
    <div className="output-toolbar" role="toolbar" aria-label="Output tools">
      <IconButton
        size="sm"
        label="Search output"
        icon={MagnifyingGlass}
        shortcut={['Mod', 'F']}
        aria-pressed={searchOpen}
        onClick={() => onSearchOpenChange(!searchOpen)}
      />
      <IconButton
        size="sm"
        label="Copy output"
        icon={Copy}
        {...(empty ? { disabledReason: nothing } : {})}
        onClick={() => void copyAll()}
      />
      <IconButton
        size="sm"
        label="Clear output"
        icon={Broom}
        {...(empty ? { disabledReason: nothing } : {})}
        onClick={onClear}
      />
      <IconButton
        size="sm"
        label={timestamps ? 'Hide timestamps' : 'Show timestamps'}
        icon={Clock}
        aria-pressed={timestamps}
        onClick={() => onTimestampsChange(!timestamps)}
      />
      <Button
        size="sm"
        variant="ghost"
        className="output-toolbar__wrap"
        aria-pressed={wrap}
        onClick={() => onWrapChange(!wrap)}
      >
        Wrap
      </Button>
      <IconButton
        size="sm"
        label="Open logs"
        icon={Scroll}
        onClick={() => void navigate(settingsPath(projectId, 'logs'))}
      />
    </div>
  );
}

/** The find row above the output: a field, the count, and next/previous. */
export function OutputSearch({
  query,
  onQueryChange,
  count,
  active,
  onStep,
  onClose,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  count: number;
  active: number;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
}): React.JSX.Element {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const summary = query === '' ? '' : count === 0 ? 'No matches' : `${active + 1} of ${count}`;
  const none = count === 0 ? 'No matches to move between.' : undefined;

  return (
    <div className="output-search" role="search">
      <Input
        ref={field}
        size="sm"
        className="output-search__field"
        aria-label="Search output"
        placeholder="Search output"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="output-search__count" aria-live="polite">
        {summary}
      </span>
      <IconButton
        size="sm"
        label="Previous match"
        icon={CaretUp}
        shortcut={['Shift', 'Enter']}
        {...(none ? { disabledReason: none } : {})}
        onClick={() => onStep(-1)}
      />
      <IconButton
        size="sm"
        label="Next match"
        icon={CaretDown}
        shortcut={['Enter']}
        {...(none ? { disabledReason: none } : {})}
        onClick={() => onStep(1)}
      />
      <IconButton size="sm" label="Close search" icon={X} onClick={onClose} />
    </div>
  );
}
