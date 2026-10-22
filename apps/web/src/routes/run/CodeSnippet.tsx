import { useEffect, useState } from 'react';
import { RUNTIME_DEFINITIONS, RUNTIME_LANGUAGES, type RuntimeLanguage } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { fetchRuntimeState } from '../../lib/runtime-api.js';
import { useResource } from '../../lib/use-resource.js';
import { Code } from '../../ui/icons.js';
import {
  Button,
  Callout,
  CodeBlock,
  SectionHeader,
  SegmentedControl,
  Skeleton,
} from '../../ui/index.js';
import './run.css';

/** The one-liner that reads an environment variable, per runtime. */
export function envSnippet(language: RuntimeLanguage, name: string): string | undefined {
  switch (language) {
    case 'node':
      return `const value = process.env.${name};`;
    case 'python':
      return `import os\n\nvalue = os.environ["${name}"]`;
    case 'go':
      return `value := os.Getenv("${name}")`;
    case 'ruby':
      return `value = ENV["${name}"]`;
    case 'static':
      // A static site has no server-side code; nothing reads the environment.
      return undefined;
  }
}

/** A snippet for one language. Pure; the section below chooses the language. */
export function CodeSnippet({
  language,
  name,
}: {
  language: RuntimeLanguage;
  name: string;
}): React.JSX.Element {
  const code = envSnippet(language, name);
  if (!code) {
    return (
      <Callout tone="info" title="A static site has no server code.">
        Variables and secrets are given to a running program; a site served as files does not read
        them.
      </Callout>
    );
  }
  return (
    <CodeBlock code={code} label={`${RUNTIME_DEFINITIONS[language].displayName} example`} copy />
  );
}

/**
 * "How your code reads these": the snippet for the language the project runs,
 * with the others a click away. The language comes from the environment when
 * one exists, else from what the platform detected in the files.
 */
export function HowCodeReadsSection({
  projectId,
  /** The variable the example names; the first real one reads better than a placeholder. */
  exampleName = 'API_TOKEN',
}: {
  projectId: string;
  exampleName?: string;
}): React.JSX.Element {
  const read = useResource((signal) => fetchRuntimeState(projectId, signal), [projectId]);
  const detected = read.data?.runtime?.language ?? read.data?.detected?.language;
  const [chosen, setChosen] = useState<RuntimeLanguage | undefined>();
  // Follows detection until the person picks a language themselves.
  useEffect(() => {
    if (detected) setChosen((current) => current ?? detected);
  }, [detected]);
  const language = chosen ?? detected ?? 'node';

  return (
    <section className="run-section run-snippet" aria-labelledby="how-code-reads-heading">
      <SectionHeader
        title={<span id="how-code-reads-heading">How your code reads these</span>}
        icon={Code}
        description="Variables and secrets arrive as environment variables when the environment starts."
      />
      {read.status === 'loading' && !read.data ? (
        <Skeleton shape="block" height={72} />
      ) : read.status === 'error' && !read.data ? (
        <Callout
          tone="danger"
          title={
            read.error instanceof ApiError
              ? read.error.message
              : 'The project language could not be read.'
          }
          action={
            <Button size="sm" onClick={read.reload}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          <SegmentedControl
            label="Language"
            size="sm"
            value={language}
            onValueChange={(next) => setChosen(next as RuntimeLanguage)}
            items={RUNTIME_LANGUAGES.map((item) => ({
              value: item,
              label: RUNTIME_DEFINITIONS[item].displayName,
            }))}
          />
          <CodeSnippet language={language} name={exampleName} />
        </>
      )}
    </section>
  );
}
