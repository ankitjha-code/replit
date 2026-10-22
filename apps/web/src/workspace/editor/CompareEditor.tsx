import { useEffect, useRef } from 'react';
import { readToken } from '../../theme/read-tokens.js';
import { useEditorSettings } from './editor-settings.js';
import { configureMonaco } from './monaco-setup.js';
import { currentEditorThemeName } from './monaco-theme.js';

export interface CompareEditorProps {
  theirs: string;
  mine: string;
  language: string;
}

export function CompareEditor({ theirs, mine, language }: CompareEditorProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const settings = useEditorSettings();

  const initial = useRef({ theirs, mine, language, fontSize: settings.fontSize });

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let dispose: (() => void) | undefined;

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
