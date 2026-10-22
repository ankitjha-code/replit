import { useId, useState, type ReactElement } from 'react';
import { RUNTIME_DEFINITIONS, RUNTIME_LANGUAGES, type RuntimeLanguage } from '@platform/shared';
import { Button, Dialog } from '../../ui/index.js';

const storageKey = (projectId: string): string => `workspace.language.${projectId}`;

export function readRememberedLanguage(projectId: string): RuntimeLanguage | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    return raw && (RUNTIME_LANGUAGES as readonly string[]).includes(raw)
      ? (raw as RuntimeLanguage)
      : undefined;
  } catch {
    return undefined;
  }
}

export function rememberLanguage(projectId: string, language: RuntimeLanguage): void {
  try {
    window.localStorage.setItem(storageKey(projectId), language);
  } catch {}
}

export function forgetLanguage(projectId: string): void {
  try {
    window.localStorage.removeItem(storageKey(projectId));
  } catch {}
}

export const DETECTION_HINT =
  'Add a package.json, requirements.txt, go.mod, Gemfile or index.html and this is detected automatically.';

export interface LanguagePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (language: RuntimeLanguage) => Promise<void>;
}

export function LanguagePickerDialog({
  open,
  onOpenChange,
  onStart,
}: LanguagePickerDialogProps): ReactElement {
  const [language, setLanguage] = useState<RuntimeLanguage>('node');
  const [starting, setStarting] = useState(false);
  const groupId = useId();

  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      await onStart(language);
      onOpenChange(false);
    } catch {
    } finally {
      setStarting(false);
    }
  };

  const chosen = RUNTIME_DEFINITIONS[language];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!starting) onOpenChange(next);
      }}
      title="What does this project run?"
      description={DETECTION_HINT}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={starting}>
            Cancel
          </Button>
          <Button variant="primary" loading={starting} onClick={() => void start()}>
            Start with {chosen.displayName}
          </Button>
        </>
      }
    >
      <fieldset className="language-picker" aria-describedby={`${groupId}-hint`}>
        <legend className="visually-hidden">Language</legend>
        {RUNTIME_LANGUAGES.map((value) => {
          const definition = RUNTIME_DEFINITIONS[value];
          const id = `${groupId}-${value}`;
          return (
            <label key={value} htmlFor={id} className="language-picker__tile">
              <input
                id={id}
                type="radio"
                name={groupId}
                value={value}
                checked={language === value}
                onChange={() => setLanguage(value)}
                className="language-picker__radio"
              />
              <span className="language-picker__name">{definition.displayName}</span>
              <span className="language-picker__version">
                {value === 'static' ? 'HTML, CSS and JavaScript' : `Version ${definition.version}`}
              </span>
            </label>
          );
        })}
        <p id={`${groupId}-hint`} className="visually-hidden">
          {DETECTION_HINT}
        </p>
      </fieldset>
    </Dialog>
  );
}
