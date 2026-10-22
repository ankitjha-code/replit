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
  /** Identifies the buffer. Switching this swaps models, not content. */
  path: string;
  language: string;
  /** Seeds the buffer. Read when a model is created and when `revision` changes. */
  value: string;
  /**
   * Bumped by the parent when it replaces the buffer wholesale, which today
   * means a load from the server.
   *
   * The editor owns its text while it is being typed into. The parent holds a
   * copy in React state and passes it back down, and React batches updates, so
   * a re-render can carry a value several keystrokes behind. Writing that back
   * truncates what was typed. An explicit signal separates "the server gave us
   * new text" from "this is your own text coming back", which comparing
   * content cannot do reliably.
   */
  revision: number;
  readOnly: boolean;
  /**
   * The shared text for this file, when it is being edited collaboratively.
   *
   * While this is set the CRDT owns the buffer: it seeds the model, it receives
   * every keystroke, and the platform writes the file back. `value`, `revision`
   * and `onChange` are all inert for as long as it lasts, because each of them
   * exists to move text between the editor and a copy in React state that is no
   * longer the authority on anything.
   */
  sharedText?: Y.Text | undefined;
  /**
   * Everybody's cursors, drawn in the editor while the file is shared.
   *
   * Names and colours in it were stamped by the server from each account, so a
   * participant cannot choose how they appear to others.
   */
  awareness?: Awareness | undefined;
  onChange: (value: string) => void;
  onSave: () => void;
  /** Where the caret is, for the status bar. */
  onCursorChange?: ((position: CursorPosition) => void) | undefined;
}

/** Below this width line numbers and the minimap cost more room than they are worth. */
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

/** The per-viewer options, applied at creation and again whenever a setting changes. */
export function editorOptions(
  settings: EditorSettings,
  compact: boolean,
): monacoTypes.editor.IEditorOptions & monacoTypes.editor.IGlobalEditorOptions {
  return {
    tabSize: settings.tabSize,
    fontSize: settings.fontSize,
    fontLigatures: settings.ligatures,
    // The panel is narrow by default, so a horizontal scrollbar would be in
    // the way constantly; wrapping is on unless the person turns it off.
    wordWrap: settings.wordWrap ? 'on' : 'off',
    minimap: { enabled: settings.minimap && !compact },
    lineNumbers: compact ? 'off' : 'on',
    folding: !compact,
  };
}

/**
 * A Monaco instance shared across every open file.
 *
 * One editor with a model per path, rather than one editor per tab. Monaco is
 * expensive to construct, and a model holds its own undo history and cursor,
 * so switching tabs this way keeps both without paying to rebuild the editor.
 */
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

  /** The revision the model was last seeded from. */
  const seeded = useRef<number | undefined>(undefined);

  /**
   * The live binding between the shared text and the model, when there is one.
   *
   * Read by the change handler below, which is built once and therefore cannot
   * see the prop directly.
   */
  const binding = useRef<MonacoBinding | undefined>(undefined);

  // Held in refs so the editor is built once. Reading them through a ref means
  // a changed callback does not tear the editor down and rebuild it.
  const handlers = useRef({ onChange, onSave, onCursorChange });
  handlers.current = { onChange, onSave, onCursorChange };

  // Read once at creation; later changes go through updateOptions below.
  const initialOptions = useRef({ settings, compact });
  initialOptions.current = { settings, compact };

  // Read when a model is first created, without making model creation depend
  // on the text.
  const valueRef = useRef(value);
  valueRef.current = value;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;

  useEffect(() => {
    if (!container.current) return;
    const monaco = configureMonaco();

    const instance = monaco.editor.create(container.current, {
      // Monaco cannot read CSS variables itself, so the token is resolved here
      // and the theme is kept in step by monaco-setup.ts.
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

    // Bound inside the editor as well as at the document, because a keystroke
    // with focus in the editor never reaches the document handler.
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handlers.current.onSave();
    });

    const subscription = instance.onDidChangeModelContent(() => {
      /*
       * Silent while the file is shared.
       *
       * The buffer belongs to the CRDT then, and the platform writes it back:
       * reporting every keystroke upward would make the editor's own autosave
       * race the session for the same file, and the two would take turns
       * conflicting with each other. When a session ends, the very next
       * keystroke reports the whole current value, so nothing is left behind.
       */
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

  /*
   * Swap to the model for this path, creating it the first time.
   *
   * Deliberately not dependent on `value`: a model exists per file and holds
   * its own text, cursor and undo history. Recreating or reseeding it on every
   * keystroke would throw all three away.
   */
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
    // Each model keeps its own caret, so the status bar is told where this one is.
    const position = instance.getPosition();
    if (position) {
      handlers.current.onCursorChange?.({ line: position.lineNumber, column: position.column });
    }
  }, [path, language]);

  // Tab size belongs to the model, the rest to the editor.
  useEffect(() => {
    editor.current?.updateOptions(editorOptions(settings, compact));
    for (const model of models.current.values()) model.updateOptions({ tabSize: settings.tabSize });
  }, [settings, compact]);

  /*
   * Text replaced from outside: a load, or a conflict resolved elsewhere.
   * Keyed on the revision rather than on the text, so a re-render carrying the
   * editor's own words back cannot overwrite what has been typed since.
   */
  useEffect(() => {
    // A shared buffer is seeded by the CRDT and reseeding it here would replace
    // what everybody else has typed with one client's idea of the file.
    if (sharedText) return;
    if (seeded.current === revision) return;

    const model = models.current.get(path);
    if (!model) return;

    seeded.current = revision;
    if (model.getValue() !== valueRef.current) model.setValue(valueRef.current);
  }, [path, revision, sharedText]);

  /*
   * Bind the model to the shared text, while there is one.
   *
   * The binding replaces the model's content with the document's, which is
   * correct rather than destructive: the document was itself seeded from this
   * same file, and it is ahead of it by exactly the characters somebody else
   * has typed.
   *
   * Torn down whenever the path or the document changes, so a session that ends
   * leaves an ordinary editor behind rather than one still wired to a document
   * nobody is syncing.
   */
  useEffect(() => {
    const instance = editor.current;
    const model = models.current.get(path);
    if (!instance || !model || !sharedText) return;

    const live = new MonacoBinding(sharedText, model, new Set([instance]), awareness);
    binding.current = live;

    /*
     * Each remote cursor in its participant's colour.
     *
     * y-monaco draws selections with classes named after each participant's
     * awareness number; the colours come from here. The colour is checked
     * against the one shape the server produces before it goes into a
     * stylesheet — it was stamped by the server, and checking again costs a
     * regular expression.
     */
    const style = document.createElement('style');
    document.head.appendChild(style);

    /*
     * A name flag beside each caret for a moment after it moves, so a person
     * can tell whose cursor just appeared without the flags covering the code
     * for ever. The deadline per participant is read by paint(); a timer
     * repaints once the last one has passed.
     */
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
      // y-monaco destroys itself when its model is disposed, which the editor
      // teardown does before this cleanup runs; destroying it twice makes yjs
      // complain about removing a handler that is already gone.
      if (!model.isDisposed()) live.destroy();
    };
  }, [path, sharedText, awareness]);

  useEffect(() => {
    editor.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div className="editor-monaco" ref={container} data-path={path} />;
}

export default CodeEditor;

/** The only colour shape the server ever produces. Anything else is not drawn. */
const SAFE_COLOUR = /^hsl\(\d{1,3}, 70%, 45%\)$/;

/** How long a participant's name stays beside their caret after it moves. */
const NAME_FLAG_MS = 2_000;

/**
 * A CSS string literal for `content`. The name was stamped by the server from
 * the account, but it still ends up in a stylesheet, so control characters go
 * and quotes and backslashes are escaped the way CSS reads them.
 */
function cssString(value: string): string {
  // eslint-disable-next-line no-control-regex -- the control range is exactly what is stripped
  const clean = value.replace(/[\u0000-\u001f\u007f"\\]/g, '').slice(0, 40);
  return `"${clean}"`;
}
