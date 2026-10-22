import { useRef, type KeyboardEvent, type ReactElement } from 'react';
import {
  STARTER_TEMPLATES,
  type StarterId,
  type StarterTemplate,
} from '../../lib/starter-templates.js';
import { File, FileCode, FileHtml, FileJs, FilePy, type Icon } from '../../ui/icons.js';
import { cx } from '../../ui/internal/cx.js';

const ICONS: Record<StarterId, Icon> = {
  blank: File,
  node: FileJs,
  python: FilePy,
  go: FileCode,
  ruby: FileCode,
  static: FileHtml,
};

function describeFiles(template: StarterTemplate): string {
  const paths = template.files('project').map((file) => file.path);
  if (paths.length === 0) return 'No files';
  if (paths.length <= 2) return paths.join(', ');
  return `${paths.slice(0, 2).join(', ')} and ${paths.length - 2} more`;
}

function TileBody({ template }: { template: StarterTemplate }): ReactElement {
  const TileIcon = ICONS[template.id];
  return (
    <>
      <TileIcon size={20} className="starter-tile__icon" aria-hidden="true" />
      <span className="starter-tile__name">{template.name}</span>
      <span className="starter-tile__description">{template.description}</span>
      <span className="starter-tile__files">{describeFiles(template)}</span>
    </>
  );
}

export interface StarterPickerProps {
  value: StarterId;
  onChange: (id: StarterId) => void;
  label: string;
  disabled?: boolean;
}

export function StarterPicker({
  value,
  onChange,
  label,
  disabled,
}: StarterPickerProps): ReactElement {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (delta === 0) return;
    event.preventDefault();
    const count = STARTER_TEMPLATES.length;
    const next = (index + delta + count) % count;
    const template = STARTER_TEMPLATES[next];
    if (!template) return;
    onChange(template.id);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={label} className="starter-picker">
      {STARTER_TEMPLATES.map((template, index) => {
        const selected = template.id === value;
        return (
          <button
            key={template.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={cx('starter-tile', selected && 'starter-tile--selected')}
            onClick={() => onChange(template.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <TileBody template={template} />
          </button>
        );
      })}
    </div>
  );
}

export interface StarterTilesProps {
  onPick: (id: StarterId) => void;
}

export function StarterTiles({ onPick }: StarterTilesProps): ReactElement {
  return (
    <section className="starter-tiles" aria-labelledby="starter-tiles-heading">
      <h2 id="starter-tiles-heading" className="starter-tiles__heading">
        Or start from a template
      </h2>
      <p className="starter-tiles__hint">
        Each one is a small server that prints the port it listens on, so the preview appears on the
        first Run.
      </p>
      <div className="starter-picker">
        {STARTER_TEMPLATES.filter((template) => template.id !== 'blank').map((template) => (
          <button
            key={template.id}
            type="button"
            className="starter-tile"
            onClick={() => onPick(template.id)}
          >
            <TileBody template={template} />
          </button>
        ))}
      </div>
    </section>
  );
}
