/**
 * Numbers, sizes and times in the words a person would say out loud.
 *
 * One copy of each, because five settings pages grew their own `formatBytes`
 * and two of them disagreed about the unit label.
 */

const BYTE_UNITS = ['kB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

/** "1 file", "12 files", "1,204 files". The plural defaults to adding an s. */
export function formatCount(count: number, noun: string, plural = `${noun}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : plural}`;
}

export interface ChangeCounts {
  created: number;
  updated: number;
  deleted: number;
}

/** What a restore or a sync changed. "nothing changed" is a real answer. */
export function describeCounts(result: ChangeCounts): string {
  const parts = [
    result.created > 0 ? `${result.created} added` : undefined,
    result.updated > 0 ? `${result.updated} changed` : undefined,
    result.deleted > 0 ? `${result.deleted} removed` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'nothing changed' : parts.join(', ');
}

const DURATION_UNITS: ReadonlyArray<readonly [suffix: string, seconds: number]> = [
  ['d', 86_400],
  ['h', 3_600],
  ['m', 60],
  ['s', 1],
];

/**
 * "1d 2h", "3h 5m", "45s". The two largest non-zero units, which is as much
 * precision as an uptime or a build time is read with.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  let remaining = Math.floor(seconds);
  const parts: string[] = [];
  for (const [suffix, size] of DURATION_UNITS) {
    const amount = Math.floor(remaining / size);
    remaining -= amount * size;
    if (amount > 0) parts.push(`${amount}${suffix}`);
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

type DateInput = Date | string | number;

function toDate(input: DateInput): Date | undefined {
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The local date and time with its zone, so two clocks on one page can be
 * told apart. "Unknown time" rather than "Invalid Date" for a bad value.
 */
export function formatDateTime(input: DateInput): string {
  const date = toDate(input);
  if (!date) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now", "3 min ago", "2 hours ago", "in 5 min". Past a month it hands
 * back the date, because "43 days ago" is harder to place than "12 Aug".
 */
export function relativeTime(input: DateInput, now: number = Date.now()): string {
  const date = toDate(input);
  if (!date) return 'Unknown time';
  const delta = date.getTime() - now;
  const distance = Math.abs(delta);

  if (distance < 45_000) return 'just now';

  const phrase = (amount: number, unit: string, plural: string): string => {
    const words = `${amount} ${amount === 1 ? unit : plural}`;
    return delta < 0 ? `${words} ago` : `in ${words}`;
  };

  if (distance < HOUR) return phrase(Math.round(distance / MINUTE), 'min', 'min');
  if (distance < DAY) return phrase(Math.round(distance / HOUR), 'hour', 'hours');
  if (distance < 30 * DAY) return phrase(Math.round(distance / DAY), 'day', 'days');

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}
