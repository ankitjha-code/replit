import { useEffect, useState, type ReactElement } from 'react';
import { Button, IconButton } from '../../ui/index.js';
import { Browser, Play, X } from '../../ui/icons.js';

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
  } catch {}
}

export const GUIDE_TEXT: Record<GuideStage, string> = {
  start: 'Next: press Start to create the environment',
  run: 'Environment ready. Press Run to start the app.',
  preview: 'Your app is running. The preview is on the right.',
};

export const GUIDE_TEXT_PREVIEW_TAB = 'Your app is running. Open it in a tab.';

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
  framable?: boolean;
  phone?: boolean;
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
