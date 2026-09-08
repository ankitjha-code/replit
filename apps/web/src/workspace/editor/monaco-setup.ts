import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

/**
 * Monaco, bundled and served by us.
 *
 * The usual integration loads the editor from a public CDN. That would make a
 * self-hosted platform depend on someone else's network to edit a file, and
 * would send every workspace visit to a third party. Bundling costs build size
 * and buys independence, which is the right trade for something that must run
 * on a laptop with no internet.
 *
 * The language services run in web workers, so parsing a large file does not
 * freeze the interface.
 */
declare global {
  interface Window {
    /** Monaco reads this to find its language workers. */
    MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker };
  }
}

let configured = false;

export function configureMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_id: string, label: string) {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  // The editor is one surface of a dark application, so it uses the same
  // tokens rather than Monaco's own dark theme, which would not match.
  monaco.editor.defineTheme('platform-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#161b22',
      'editorGutter.background': '#161b22',
      'editor.lineHighlightBackground': '#1c2128',
      'editorLineNumber.foreground': '#6e7681',
      'editorLineNumber.activeForeground': '#9198a1',
      'editor.selectionBackground': '#2d4f7c',
      'editorIndentGuide.background1': '#21262d',
      'editorWidget.background': '#1c2128',
      'editorWidget.border': '#30363d',
    },
  });

  /*
   * The project's TypeScript is not this browser's TypeScript: there are no
   * installed dependencies to resolve, so every import would be underlined as
   * missing. Diagnostics stay off until a runtime exists that can tell the
   * editor what is actually installed.
   */
  for (const defaults of [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
  ]) {
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  }

  return monaco;
}

export type Monaco = typeof monaco;
