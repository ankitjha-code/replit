import { Route, Routes, useMatch } from 'react-router-dom';
import { NotFoundPage } from './NotFoundPage.js';
import { AccountLayout } from './account/AccountLayout.js';
import { CloseAccountSection } from './account/CloseAccountSection.js';
import { ProfileSection } from './account/ProfileSection.js';
import { SecuritySection } from './account/SecuritySection.js';
import { SessionsSection } from './account/SessionsSection.js';
import { UsageSection } from './account/UsageSection.js';
import { findAccountSection } from './account/pages.js';

export function AccountPage(): React.JSX.Element {
  const match = useMatch('/account/:page/*');
  const section = findAccountSection(match?.params.page);
  if (!section) return <NotFoundPage />;

  return (
    <AccountLayout current={section}>
      <Routes>
        <Route index element={<ProfileSection />} />
        <Route path="security" element={<SecuritySection />} />
        <Route path="sessions" element={<SessionsSection />} />
        <Route path="usage" element={<UsageSection />} />
        <Route path="close" element={<CloseAccountSection />} />
      </Routes>
    </AccountLayout>
  );
}
