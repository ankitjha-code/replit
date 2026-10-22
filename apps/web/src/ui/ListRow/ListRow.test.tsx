import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '../Badge/Badge.js';
import { ListRow } from './ListRow.js';

describe('ListRow', () => {
  it('lays out title, description, meta, badge, actions and an expanded block', () => {
    render(
      <ul>
        <ListRow
          title="deploy-42"
          description="main at 1a2b3c"
          meta="3 min ago"
          badge={<Badge tone="ok">Live</Badge>}
          actions={<button type="button">Open deploy-42</button>}
          expanded={<pre>build log</pre>}
          selected
        />
      </ul>,
    );
    const item = screen.getByRole('listitem');
    expect(item).toHaveAttribute('aria-selected', 'true');
    expect(item).toHaveTextContent('deploy-42');
    expect(item).toHaveTextContent('main at 1a2b3c');
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open deploy-42' })).toBeInTheDocument();
    expect(screen.getByText('build log').closest('.ui-list-row__expanded')).not.toBeNull();
  });

  it('can put the facts before the actions where the row wraps on a phone', () => {
    render(
      <ul>
        <ListRow title="alice" meta="Joined today" actions={<button type="button">x</button>} />
        <ListRow title="bob" meta="Joined today" metaFirst />
      </ul>,
    );
    const [plain, metaFirst] = screen.getAllByRole('listitem');
    expect(plain).not.toHaveClass('ui-list-row--meta-first');
    expect(metaFirst).toHaveClass('ui-list-row--meta-first');
    const children = [...plain!.querySelector('.ui-list-row__main')!.children].map(
      (child) => child.className,
    );
    expect(children.indexOf('ui-list-row__meta')).toBeLessThan(
      children.indexOf('ui-list-row__actions'),
    );
  });
});
