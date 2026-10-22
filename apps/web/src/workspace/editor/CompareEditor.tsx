import { useEffect, useRef } from 'react';
import { readToken } from '../../theme/read-tokens.js';
import { useEditorSettings } from './editor-settings.js';
import { configureMonaco } from './monaco-setup.js';
import { currentEditorThemeName } from './monaco-theme.js';

export interface CompareEditorProps {
  /** The server's version, on the left. */
  theirs: string;
  /** This buffer, on the right. */
  mine: string;
  language: string;
}

/**
 * A read-only Monaco diff of the two versions of a conflicted file.
 *
 * Loaded lazily by CompareDialog so Monaco is fetched only when a diff is
 * actually opened. Both sides are read-only: the decision is made with the
 * buttons under it, never by editing the comparison.
 */
export function CompareEditor({ theirs, mine, language }: CompareEditorProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const settings = useEditorSettings();

  // The texts are fixed for the life of the dialog (a new conflict is a new
  // dialog), so they are read once rather than rebuilding the diff on render.
  const initial = useRef({ theirs, mine, language, fontSize: settings.fontSize });

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let dispose: (() => void) | undefined;

    /*
     * Built on the next frame rather than synchronously. Monaco computes the
     * diff in its worker against mirrors of both models; models disposed
     * before that answer arrives make it reject with "no diff result
     * available". React's development double-mount disposes the first pair
     * at once, so the first frame's work is skipped instead of torn down.
     */
    const frame = requestAnimationFrame(() => {
      const monaco = configureMonaco();
      const { theirs: left, mine: right, language: lang, fontSize } = initial.current;

      const original = monaco.editor.createModel(left, lang);
      const modified = monaco.editor.createModel(right, lang);
      const diff = monaco.editor.createDiffEditor(host, {
        theme: currentEditorThemeName(),
        fontFamily: readToken('--font-mono') || 'monospace',
        fontSize,
        lineHeight: 20,
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
      });
      diff.setModel({ original, modified });

      dispose = () => {
        diff.dispose();
        original.dispose();
        modified.dispose();
      };
    });

    return () => {
      cancelAnimationFrame(frame);
      dispose?.();
    };
  }, []);

  return <div className="editor-compare__surface" ref={container} />;
}

export default CompareEditor;
