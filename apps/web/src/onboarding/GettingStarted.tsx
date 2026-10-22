import { useId, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ProjectSummary, PublicUser } from '@platform/shared';
import { Button, Callout, Card, Meter, Skeleton } from '../ui/index.js';
import { Check, Circle } from '../ui/icons.js';
import { useShowsEmailStep } from './email-step.js';
import { useOnboarding, type ChecklistItem, CHECKLIST_LENGTH } from './use-onboarding.js';
import { useResendVerification } from './use-resend-verification.js';
import './onboarding.css';

export interface GettingStartedProps {
  user: PublicUser;
  projects: readonly ProjectSummary[];
  onCreate: () => void;
}

export function GettingStarted({
  user,
  projects,
  onCreate,
}: GettingStartedProps): ReactElement | null {
  const onboarding = useOnboarding(user, projects);
  const headingId = useId();
  const resend = useResendVerification();
  useShowsEmailStep(
    onboarding.visible && onboarding.items.some((item) => item.id === 'email' && !item.done),
  );

  if (!onboarding.visible) return null;

  const { project } = onboarding;
  const workspace = project ? `/projects/${project.id}` : undefined;

  const actionFor = (item: ChecklistItem): ReactNode => {
    if (item.done) return null;
    switch (item.id) {
      case 'create':
        return (
          <Button variant="link" onClick={onCreate}>
            Pick a starter
          </Button>
        );
      case 'start':
        return workspace ? (
          <Button variant="link" asChild>
            <Link to={workspace}>Open the workspace</Link>
          </Button>
        ) : null;
      case 'run':
        return workspace ? (
          <Button variant="link" asChild>
            <Link to={workspace} state={{ focus: 'console' }}>
              Open the console
            </Link>
          </Button>
        ) : null;
      case 'preview':
        return workspace ? (
          <Button variant="link" asChild>
            <Link to={workspace} state={{ focus: 'preview' }}>
              Open the preview
            </Link>
          </Button>
        ) : null;
      case 'email':
        return (
          <Button
            variant="link"
            onClick={() => void resend.send()}
            loading={resend.busy}
            {...(resend.cooldown > 0
              ? { disabledReason: `Sent. You can send another in ${resend.cooldown}s.` }
              : {})}
          >
            Resend link
          </Button>
        );
    }
  };

  return (
    <Card as="section" className="getting-started" aria-labelledby={headingId}>
      <header className="getting-started__head">
        <h2 id={headingId} className="getting-started__title">
          Getting started
        </h2>
        <Meter
          className="getting-started__meter"
          value={onboarding.doneCount}
          max={CHECKLIST_LENGTH}
          label="Steps done"
          format={(value) => `${value} of ${CHECKLIST_LENGTH}`}
          loading={onboarding.status === 'loading'}
        />
        <Button variant="ghost" size="sm" onClick={onboarding.hide}>
          Hide
        </Button>
      </header>

      {onboarding.status === 'loading' ? (
        <div aria-busy="true" className="getting-started__loading">
          <Skeleton lines={CHECKLIST_LENGTH} />
        </div>
      ) : (
        <>
          {onboarding.status === 'error' ? (
            <Callout
              tone="danger"
              title="Could not check your progress."
              action={
                <Button size="sm" onClick={onboarding.reload}>
                  Retry
                </Button>
              }
            />
          ) : null}
          <ol className="checklist">
            {onboarding.items.map((item, index) => {
              const current = !item.done && onboarding.items.findIndex((i) => !i.done) === index;
              return (
                <li
                  key={item.id}
                  className="checklist__item"
                  data-done={item.done ? 'true' : 'false'}
                  aria-current={current ? 'step' : undefined}
                >
                  <span className="checklist__mark" aria-hidden="true">
                    {item.done ? <Check size={14} weight="bold" /> : <Circle size={14} />}
                  </span>
                  <div className="checklist__text">
                    <span className="checklist__label">
                      <span className="visually-hidden">{item.done ? 'Done: ' : 'To do: '}</span>
                      {item.label}
                    </span>
                    <span className="checklist__detail">{item.detail}</span>
                  </div>
                  <span className="checklist__action">{actionFor(item)}</span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Card>
  );
}
