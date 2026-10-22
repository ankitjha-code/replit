import { useEffect, useState, type ReactElement } from 'react';
import { Button, IconButton } from '../../ui/index.js';
import { Browser, Play, X } from '../../ui/icons.js';

/**
 * One hint at a time under the toolbar (design spec 8.3): which button to
 * press next, and a "Show me" that flashes it. Never modal. Dismissed once
 * per account, and gone by itself once the app has run.
 */

export type GuideStage = 'start' | 'run' | 'preview';

const storageKey = (userId: string): string => `onboarding.guide.v1.${userId}`;

export function readGuideHidden(userId: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function writeGuideHidden(userId: string): void {
  try {
    window.localStorage.setItem(storageKey(userId), '1');
  } catch {
    // A hint that comes back is a small cost.
  }
}

export const GUIDE_TEXT: Record<GuideStage, string> = {
  start: 'Next: press Start to create the environment',
  run: 'Environment ready. Press Run to start the app.',
  preview: 'Your app is running. The preview is on the right.',
};

export const GUIDE_TEXT_PREVIEW_TAB = 'Your app is running. Open it in a tab.';

/** On a phone the preview is one of the panels to switch to, not beside anything. */
export const GUIDE_TEXT_PREVIEW_PHONE = 'Your app is running. Switch to Preview to see it.';

export function GuideStrip({
  userId,
  stage,
  framable = true,
  phone = false,
  onShowMe,
}: {
  userId: string;
  stage: GuideStage;
  /** False on plain-HTTP installs, where the preview opens in a tab. */
  framable?: boolean;
  /** The phone layout, where panels are switched between rather than side by side. */
  phone?: boolean;
  /** Flashes the control for the stage: Start, Run or the preview. */
  onShowMe: (stage: GuideStage) => void;
}): ReactElement | null {
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    setHidden(readGuideHidden(userId));
  }, [userId]);

  if (hidden) return null;

  const hide = (): void => {
    writeGuideHidden(userId);
    setHidden(true);
  };

  const text =
    stage !== 'preview'
      ? GUIDE_TEXT[stage]
      : !framable
        ? GUIDE_TEXT_PREVIEW_TAB
        : phone
          ? GUIDE_TEXT_PREVIEW_PHONE
          : GUIDE_TEXT.preview;
  const Icon = stage === 'preview' ? Browser : Play;
  const target = stage === 'start' ? 'Start' : stage === 'run' ? 'Run' : 'preview';

  return (
    <div className="guide-strip" role="status" aria-label="Getting started">
      <Icon size={16} aria-hidden="true" className="guide-strip__icon" />
      <span className="guide-strip__text">{text}</span>
      {stage === 'preview' ? (
        <Button variant="link" size="sm" onClick={hide}>
          Hide guide
        </Button>
      ) : (
        <>
          <Button
            variant="link"
            size="sm"
            onClick={() => onShowMe(stage)}
            aria-describedby="guide-strip-show-me"
          >
            Show me
          </Button>
          <span id="guide-strip-show-me" className="visually-hidden">
            Flashes the {target} button so you can find it
          </span>
          <IconButton label="Hide guide" icon={X} size="sm" onClick={hide} />
        </>
      )}
    </div>
  );
}
