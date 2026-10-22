import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GUIDE_TEXT,
  GUIDE_TEXT_PREVIEW_PHONE,
  GUIDE_TEXT_PREVIEW_TAB,
  GuideStrip,
  readGuideHidden,
} from './GuideStrip.js';

/** One hint at a time under the toolbar (design spec 8.3). */

const USER = '018f0000-0000-7000-8000-000000000001';

beforeEach(() => window.localStorage.clear());

describe('GuideStrip', () => {
  it('names the next button for each stage and flashes it on "Show me"', async () => {
    const onShowMe = vi.fn();
    const { rerender } = render(<GuideStrip userId={USER} stage="start" onShowMe={onShowMe} />);

    const strip = await screen.findByRole('status', { name: 'Getting started' });
    expect(strip).toHaveTextContent(GUIDE_TEXT.start);
    await userEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(onShowMe).toHaveBeenCalledWith('start');

    rerender(<GuideStrip userId={USER} stage="run" onShowMe={onShowMe} />);
    expect(strip).toHaveTextContent(GUIDE_TEXT.run);

    rerender(<GuideStrip userId={USER} stage="preview" onShowMe={onShowMe} />);
    expect(strip).toHaveTextContent(GUIDE_TEXT.preview);
  });

  it('points at a new tab when the preview cannot be framed', async () => {
    render(
      <GuideStrip userId={USER} stage="preview" framable={false} onShowMe={() => undefined} />,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(GUIDE_TEXT_PREVIEW_TAB);
  });

  it('does not point to the right on a phone, where the preview is a panel to switch to', async () => {
    render(<GuideStrip userId={USER} stage="preview" phone onShowMe={() => undefined} />);
    const strip = await screen.findByRole('status');
    expect(strip).toHaveTextContent(GUIDE_TEXT_PREVIEW_PHONE);
    expect(strip).not.toHaveTextContent(/on the right/);
  });

  it('is dismissed once per account and stays away', async () => {
    const { unmount } = render(
      <GuideStrip userId={USER} stage="start" onShowMe={() => undefined} />,
    );
    await screen.findByRole('status');
    await userEvent.click(screen.getByRole('button', { name: 'Hide guide' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(readGuideHidden(USER)).toBe(true);
    unmount();

    render(<GuideStrip userId={USER} stage="start" onShowMe={() => undefined} />);
    // Hidden from the first paint: no flash of the strip before storage is read.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Another account on the same browser still gets the guide.
    render(<GuideStrip userId="someone-else" stage="start" onShowMe={() => undefined} />);
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });
});
