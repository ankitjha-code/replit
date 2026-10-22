import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { RUNTIME_DEFINITIONS, RUNTIME_LANGUAGES } from '@platform/shared';
import { Badge, Button, Callout, Skeleton } from '../../ui/index.js';
import { ArrowClockwise, Code, Cube, Globe } from '../../ui/icons.js';
import './projects.css';

export interface LandingProps {
  loading?: boolean;
  unreachable?: boolean;
  onRetry?: () => void;
}

const STEPS: ReadonlyArray<{ icon: typeof Code; title: string; body: string }> = [
  {
    icon: Code,
    title: 'Edit in the browser',
    body: 'A real editor with your files, autosave and live collaboration.',
  },
  {
    icon: Cube,
    title: 'Run in an isolated environment',
    body: 'Each project gets its own container with the runtime it needs.',
  },
  {
    icon: Globe,
    title: 'Deploy with a Live URL',
    body: 'Ship from the same place you build, on a subdomain or your own domain.',
  },
];

export function Landing({
  loading = false,
  unreachable = false,
  onRetry,
}: LandingProps): ReactElement {
  return (
    <div className="landing-page page">
      {unreachable ? (
        <Callout
          tone="warn"
          title="The server could not be reached. Signed-in state is unknown."
          action={
            <Button size="sm" icon={ArrowClockwise} onClick={onRetry}>
              Retry
            </Button>
          }
        />
      ) : null}

      <section className="landing-page__hero" aria-busy={loading || undefined}>
        {loading ? (
          <>
            <Skeleton width="min(520px, 100%)" height={32} />
            <Skeleton width="min(440px, 100%)" height={20} />
            <div className="landing-page__actions">
              <Skeleton width={150} height={32} />
              <Skeleton width={80} height={32} />
            </div>
          </>
        ) : (
          <>
            <h1 className="landing-page__title">Build and run applications in the browser</h1>
            <p className="landing-page__lede">
              Create a project, edit code, run it in an isolated environment, and share what you
              make.
            </p>
            <div className="landing-page__actions">
              <Button variant="primary" size="lg" asChild>
                <Link to="/register">Create an account</Link>
              </Button>
              <Button size="lg" asChild>
                <Link to="/login">Sign in</Link>
              </Button>
            </div>
          </>
        )}
      </section>

      <ul className="landing-page__languages" aria-label="Supported runtimes">
        {RUNTIME_LANGUAGES.map((language) => {
          const definition = RUNTIME_DEFINITIONS[language];
          return (
            <li key={language}>
              <Badge>
                {definition.displayName} {definition.version}
              </Badge>
            </li>
          );
        })}
      </ul>

      <dl className="landing-page__steps">
        {STEPS.map((step) => (
          <div key={step.title} className="landing-page__step">
            <dt>
              <step.icon size={20} aria-hidden="true" className="landing-page__step-icon" />
              {step.title}
            </dt>
            <dd>{step.body}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
