import type { PointerEvent } from 'react';
import { Button } from '../../ui/index.js';

/**
 * The keys a phone keyboard does not have (design spec 9.7).
 *
 * Tab completes, Esc leaves a pager, the arrows walk history, and Ctrl arms
 * the next letter typed as a control character (Ctrl then C interrupts). The
 * buttons never take focus, so the on-screen keyboard stays up while they are
 * pressed.
 */

const KEYS: { label: string; name: string; data: string }[] = [
  { label: 'Tab', name: 'Tab', data: '\t' },
  { label: 'Esc', name: 'Escape', data: '\u001b' },
  { label: '↑', name: 'Up arrow', data: '\u001b[A' },
  { label: '↓', name: 'Down arrow', data: '\u001b[B' },
  { label: '←', name: 'Left arrow', data: '\u001b[D' },
  { label: '→', name: 'Right arrow', data: '\u001b[C' },
];

/** Turns a typed character into its control character while Ctrl is armed. */
export function withControl(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  // @ through _ (A-Z and a few symbols) map onto 0-31.
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
}

export function TerminalKeyRow({
  onKey,
  ctrlArmed,
  onCtrlChange,
}: {
  onKey: (data: string) => void;
  ctrlArmed: boolean;
  onCtrlChange: (armed: boolean) => void;
}): React.JSX.Element {
  // Keeps focus (and the keyboard) on the terminal while a key is tapped.
  const keepFocus = (event: PointerEvent<HTMLButtonElement>): void => event.preventDefault();

  return (
    <div className="term-keys" role="toolbar" aria-label="Terminal keys">
      <Button
        size="sm"
        variant={ctrlArmed ? 'secondary' : 'ghost'}
        className="term-keys__key"
        aria-pressed={ctrlArmed}
        onPointerDown={keepFocus}
        onClick={() => onCtrlChange(!ctrlArmed)}
      >
        Ctrl
      </Button>
      {KEYS.map((key) => (
        <Button
          key={key.name}
          size="sm"
          variant="ghost"
          className="term-keys__key"
          aria-label={key.name}
          onPointerDown={keepFocus}
          onClick={() => onKey(key.data)}
        >
          {key.label}
        </Button>
      ))}
    </div>
  );
}
