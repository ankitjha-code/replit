import { useEffect, useRef, useSyncExternalStore } from 'react';
import type * as monacoTypes from 'monaco-editor';
import { MonacoBinding } from 'y-monaco';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { readToken } from '../../theme/read-tokens.js';
import { useEditorSettings, type EditorSettings } from './editor-settings.js';
import { configureMonaco } from './monaco-setup.js';
import { currentEditorThemeName } from './monaco-theme.js';

export interface CursorPosition {
  line: number;
  column: number;
}

export interface CodeEditorProps {
  path: string;
  language: string;
  value: string;
  revision: number;
  readOnly: boolean;
  sharedText?: Y.Text | undefined;
  awareness?: Awareness | undefined;
  onChange: (value: string) => void;
  onSave: () => void;
  onCursorChange?: ((position: CursorPosition) => void) | undefined;
}

const COMPACT_QUERY = '(max-width: 479px)';

function subscribeCompact(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

function isCompact(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_QUERY).matches;
}

export function editorOptions(
  settings: EditorSettings,
  compact: boolean,
): monacoTypes.editor.IEditorOptions & monacoTypes.editor.IGlobalEditorOptions {
  return {
    tabSize: settings.tabSize,
    fontSize: settings.fontSize,
    fontLigatures: settings.ligatures,
    wordWrap: settings.wordWrap ? 'on' : 'off',
    minimap: { enabled: settings.minimap && !compact },
    lineNumbers: compact ? 'off' : 'on',
    folding: !compact,
  };
}

export function CodeEditor({
  path,
  language,
  value,
  revision,
  readOnly,
  sharedText,
  awareness,
  onChange,
  onSave,
  onCursorChange,
}: CodeEditorProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const settings = useEditorSettings();
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false);
  const editor = useRef<monacoTypes.editor.IStandaloneCodeEditor>(null);
  const models = useRef(new Map<string, monacoTypes.editor.ITextModel>());

  const seeded = useRef<number | undefined>(undefined);

  const binding = useRef<MonacoBinding | undefined>(undefined);

  const handlers = useRef({ onChange, onSave, onCursorChange });
  handlers.current = { onChange, onSave, onCursorChange };

  const initialOptions = useRef({ settings, compact });
  initialOptions.current = { settings, compact };

  const valueRef = useRef(value);
  valueRef.current = value;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;

  useEffect(() => {
    if (!container.current) return;
    const monaco = configureMonaco();

    const instance = monaco.editor.create(container.current, {
      theme: currentEditorThemeName(),
      fontFamily: readToken('--font-mono') || 'monospace',
      lineHeight: 20,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      padding: { top: 8 },
      ...editorOptions(initialOptions.current.settings, initialOptions.current.compact),
    });

    editor.current = instance;

    const cursor = instance.onDidChangeCursorPosition((event) => {
      handlers.current.onCursorChange?.({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });

    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handlers.current.onSave();
    });

    const subscription = instance.onDidChangeModelContent(() => {
      if (binding.current) return;
      handlers.current.onChange(instance.getValue());
    });

    return () => {
      cursor.dispose();
      subscription.dispose();
      instance.dispose();
      editor.current = null;
      for (const model of models.current.values()) model.dispose();
      models.current.clear();
    };
  }, []);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;

    const monaco = configureMonaco();
    let model = models.current.get(path);

    if (!model) {
      model = monaco.editor.createModel(valueRef.current, language);
      model.updateOptions({ tabSize: initialOptions.current.settings.tabSize });
      models.current.set(path, model);
      seeded.current = revisionRef.current;
    }

    if (instance.getModel() !== model) instance.setModel(model);
    const position = instance.getPosition();
    if (position) {
      handlers.current.onCursorChange?.({ line: position.lineNumber, column: position.column });
    }
  }, [path, language]);

  useEffect(() => {
    editor.current?.updateOptions(editorOptions(settings, compact));
    for (const model of models.current.values()) model.updateOptions({ tabSize: settings.tabSize });
  }, [settings, compact]);

  useEffect(() => {
    if (sharedText) return;
    if (seeded.current === revision) return;

    const model = models.current.get(path);
    if (!model) return;

    seeded.current = revision;
    if (model.getValue() !== valueRef.current) model.setValue(valueRef.current);
  }, [path, revision, sharedText]);

  useEffect(() => {
    const instance = editor.current;
    const model = models.current.get(path);
    if (!instance || !model || !sharedText) return;

    const live = new MonacoBinding(sharedText, model, new Set([instance]), awareness);
    binding.current = live;

    const style = document.createElement('style');
    document.head.appendChild(style);

    const flagUntil = new Map<number, number>();
    let flagTimer: ReturnType<typeof setTimeout> | undefined;

    const paint = (): void => {
      if (!awareness) return;
      const rules: string[] = [];
      const now = Date.now();
      awareness.getStates().forEach((state, id) => {
        if (id === awareness.clientID) return;
        const user = (state as { user?: { colour?: unknown; name?: unknown } }).user;
        const colour = user?.colour;
        if (typeof colour !== 'string' || !SAFE_COLOUR.test(colour)) return;
        rules.push(
          `.yRemoteSelection-${String(id)}{background-color:${colour};opacity:.25}`,
          `.yRemoteSelectionHead-${String(id)}{border-left:2px solid ${colour}}`,
        );
        const until = flagUntil.get(id);
        if (until !== undefined && until > now && typeof user?.name === 'string') {
          rules.push(
            `.yRemoteSelectionHead-${String(id)}::after{content:${cssString(user.name)};background-color:${colour}}`,
          );
        }
      });
      style.textContent = rules.join('\n');
    };

    const onAwarenessChange = (changes: {
      added: number[];
      updated: number[];
      removed: number[];
    }): void => {
      const deadline = Date.now() + NAME_FLAG_MS;
      for (const id of [...changes.added, ...changes.updated]) flagUntil.set(id, deadline);
      for (const id of changes.removed) flagUntil.delete(id);
      paint();
      if (flagTimer !== undefined) clearTimeout(flagTimer);
      flagTimer = setTimeout(paint, NAME_FLAG_MS + 50);
    };

    paint();
    awareness?.on('change', onAwarenessChange);

    return () => {
      if (flagTimer !== undefined) clearTimeout(flagTimer);
      awareness?.off('change', onAwarenessChange);
      style.remove();
      binding.current = undefined;
      if (!model.isDisposed()) live.destroy();
    };
  }, [path, sharedText, awareness]);

  useEffect(() => {
    editor.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div className="editor-monaco" ref={container} data-path={path} />;
}

export default CodeEditor;

const SAFE_COLOUR = /^hsl\(\d{1,3}, 70%, 45%\)$/;

const NAME_FLAG_MS = 2_000;

function cssString(value: string): string {
  // eslint-disable-next-line no-control-regex -- the control range is exactly what is stripped
  const clean = value.replace(/[\u0000-\u001f\u007f"\\]/g, '').slice(0, 40);
  return `"${clean}"`;
}
