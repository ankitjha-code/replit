import { useEffect, useRef } from 'react';
import type * as monacoTypes from 'monaco-editor';
import { MonacoBinding } from 'y-monaco';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { configureMonaco } from './monaco-setup.js';

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
}: CodeEditorProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
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
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

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
      theme: 'platform-dark',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2,
      // The panel is narrow by default, so a horizontal scrollbar would be in
      // the way constantly.
      wordWrap: 'on',
      padding: { top: 8 },
    });

    editor.current = instance;

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
      models.current.set(path, model);
      seeded.current = revisionRef.current;
    }

    if (instance.getModel() !== model) instance.setModel(model);
  }, [path, language]);

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

    const paint = (): void => {
      if (!awareness) return;
      const rules: string[] = [];
      awareness.getStates().forEach((state, id) => {
        if (id === awareness.clientID) return;
        const colour = (state as { user?: { colour?: unknown } }).user?.colour;
        if (typeof colour !== 'string' || !SAFE_COLOUR.test(colour)) return;
        rules.push(
          `.yRemoteSelection-${String(id)}{background-color:${colour};opacity:.25}`,
          `.yRemoteSelectionHead-${String(id)}{border-left:2px solid ${colour}}`,
        );
      });
      style.textContent = rules.join('\n');
    };

    paint();
    awareness?.on('change', paint);

    return () => {
      awareness?.off('change', paint);
      style.remove();
      binding.current = undefined;
      live.destroy();
    };
  }, [path, sharedText, awareness]);

  useEffect(() => {
    editor.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div className="code-editor" ref={container} data-path={path} />;
}

export default CodeEditor;

/** The only colour shape the server ever produces. Anything else is not drawn. */
const SAFE_COLOUR = /^hsl\(\d{1,3}, 70%, 45%\)$/;
