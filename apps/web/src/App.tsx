import { NavLink, Route, Routes, useMatch } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth.js';
import { useAuth } from './lib/auth-context.js';
import { UserMenu } from './components/UserMenu.js';
import { AccountPage } from './routes/AccountPage.js';
import { ForgotPasswordPage } from './routes/ForgotPasswordPage.js';
import { OperationsPage } from './routes/OperationsPage.js';
import { ResetPasswordPage } from './routes/ResetPasswordPage.js';
import { VerifyEmailPage } from './routes/VerifyEmailPage.js';
import { HomePage } from './routes/HomePage.js';
import { SystemStatusPage } from './routes/SystemStatusPage.js';
import { LoginPage } from './routes/LoginPage.js';
import { ProjectSettingsPage } from './routes/ProjectSettingsPage.js';
import { RegisterPage } from './routes/RegisterPage.js';
import { NotFoundPage } from './routes/NotFoundPage.js';
import { WorkspacePage } from './workspace/WorkspacePage.js';
import './styles/shell.css';

/**
 * Application shell.
 *
 * The route guard here decides what to render, never what is permitted: the
 * server checks every request regardless, so a guard that could be bypassed by
 * editing the bundle grants nothing.
 */
export function App(): React.JSX.Element {
  // The workspace manages its own space edge to edge, so the page padding and
  // scrolling that suit a document would fight it.
  const inWorkspace = useMatch('/projects/:projectId') !== null;
  /*
   * Shown only to operators, and that is presentation rather than protection.
   *
   * Every route under /api/operations answers not found to anybody else, so a
   * link here grants nothing. What it avoids is a menu item that leads to a
   * refusal, which is worse than no menu item.
   */
  const { user } = useAuth();

  return (
    <div className="shell">
      <header className="shell__header">
        <NavLink to="/" className="shell__brand">
          <span className="shell__brand-mark">◆</span> Workspace
        </NavLink>
        <nav className="shell__nav">
          <NavLink to="/status">Status</NavLink>
          {user?.isOperator && <NavLink to="/operations">Operations</NavLink>}
        </nav>
        <UserMenu />
      </header>
      <main className={inWorkspace ? 'shell__main shell__main--flush' : 'shell__main'}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/status" element={<SystemStatusPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          {/*
           * Three pages a link lands on, none of them behind the sign-in guard.
           *
           * Every one of them is opened from an inbox, which is very often not
           * the browser holding the session. Requiring a session would make
           * these fail exactly where they are most likely to be used.
           */}
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route
            path="/operations"
            element={
              <RequireAuth>
                <OperationsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/account"
            element={
              <RequireAuth>
                <AccountPage />
              </RequireAuth>
            }
          />
          <Route
            path="/projects/:projectId"
            element={
              <RequireAuth>
                <WorkspacePage />
              </RequireAuth>
            }
          />
          <Route
            path="/projects/:projectId/settings"
            element={
              <RequireAuth>
                <ProjectSettingsPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
