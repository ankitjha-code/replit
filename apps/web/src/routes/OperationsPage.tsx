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
