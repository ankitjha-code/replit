import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../lib/use-document-title.js';
import { Button, EmptyState } from '../ui/index.js';
import { Question } from '../ui/icons.js';

/**
 * The one not-found page, for an unknown route and for a project that is
 * missing or not the caller's (the server deliberately does not say which).
 */
export function NotFoundPage(): ReactElement {
  useDocumentTitle(['Not found']);
  return (
    <div className="not-found">
      <EmptyState
        size="page"
        icon={Question}
        title={
          <span role="heading" aria-level={1}>
            Not found
          </span>
        }
        body="There is nothing at this address, or you do not have access to it."
        action={
          <Button variant="primary" size="lg" asChild>
            <Link to="/">Go to your projects</Link>
          </Button>
        }
      />
      <footer className="not-found__footer">
        <Link to="/status">System status</Link>
      </footer>
    </div>
  );
}
