import { Route, Routes, useMatch } from 'react-router-dom';
import { useAuth } from '../lib/auth-context.js';
import { NotFoundPage } from './NotFoundPage.js';
import { Accounts } from './operations/Accounts.js';
import { Audit } from './operations/Audit.js';
import { Cleanup } from './operations/Cleanup.js';
import { HostsPanel } from './operations/HostsPanel.js';
import { OperationsLayout } from './operations/OperationsLayout.js';
import { Overview } from './operations/Overview.js';
import { findOperationsSection } from './operations/pages.js';

export { AccountLimits } from './operations/AccountLimits.js';
export { HostsPanel } from './operations/HostsPanel.js';

/**
 * The installation, seen whole: one section per route under `/operations`.
 *
 * Everything else in this product is scoped to a project or an account.
 * **Nothing on these pages is a project's contents.** A project is a number
 * here; that is the boundary between an operator and a backdoor into
 * everybody's work, and the pages are built so there is no obvious place to
 * put a file browser.
 *
 * Someone who is not an operator sees the same not-found page the server
 * answers with. The server enforces it; hiding the page only spares them a
 * screen full of errors.
 */
export function OperationsPage(): React.JSX.Element {
  const { user } = useAuth();
  const match = useMatch('/operations/:page/*');
  const section = findOperationsSection(match?.params.page);
  if (!user?.isOperator || !section) return <NotFoundPage />;

  return (
    <OperationsLayout current={section}>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="hosts" element={<HostsPanel />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="cleanup" element={<Cleanup />} />
        <Route path="audit" element={<Audit />} />
      </Routes>
    </OperationsLayout>
  );
}
