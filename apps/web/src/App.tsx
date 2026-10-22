import { Suspense, lazy, type ReactElement, type ReactNode } from 'react';
import { Route, Routes, useLocation, useMatch } from 'react-router-dom';
import { PageSkeleton, RequireAuth } from './components/RequireAuth.js';
import { useAuth } from './lib/auth-context.js';
import { NavigationGuardProvider } from './lib/navigation-guard.js';
import { useDocumentTitle } from './lib/use-document-title.js';
import { AccountPage } from './routes/AccountPage.js';
import { ForgotPasswordPage } from './routes/ForgotPasswordPage.js';
import { HomePage } from './routes/HomePage.js';
import { LoginPage } from './routes/LoginPage.js';
import { NotFoundPage } from './routes/NotFoundPage.js';
import { OperationsPage } from './routes/OperationsPage.js';
import { ProjectSettingsPage } from './routes/ProjectSettingsPage.js';
import { RegisterPage } from './routes/RegisterPage.js';
import { ResetPasswordPage } from './routes/ResetPasswordPage.js';
import { SystemStatusPage } from './routes/SystemStatusPage.js';
import { VerifyEmailPage } from './routes/VerifyEmailPage.js';
import { AppHeader } from './shell/AppHeader.js';
import { ConnectionBanner, ShellBannerProvider } from './shell/ConnectionBanner.js';
import { ErrorBoundary } from './shell/ErrorBoundary.js';
import { SessionBanner } from './shell/SessionBanner.js';
import { SkipLinks } from './shell/SkipLinks.js';
import { UiProvider } from './ui/index.js';
import { WorkspacePage } from './workspace/WorkspacePage.js';
import './shell/shell.css';

const Gallery = import.meta.env.DEV
  ? lazy(() => import('./ui/Gallery.js').then((module) => ({ default: module.Gallery })))
  : null;

function RouteTitle({ parts }: { parts: ReadonlyArray<string | false> }): null {
  useDocumentTitle(parts);
  return null;
}

function Titled({
  parts,
  children,
}: {
  parts: ReadonlyArray<string | false>;
  children: ReactNode;
}): ReactElement {
  return (
    <>
      <RouteTitle parts={parts} />
      {children}
    </>
  );
}

export function App(): ReactElement {
  const inWorkspace = useMatch('/projects/:projectId') !== null;
  const { status } = useAuth();
  const location = useLocation();

  return (
    <UiProvider>
      <ShellBannerProvider>
        <NavigationGuardProvider>
          <div className="app-shell">
            <SkipLinks inWorkspace={inWorkspace} />
            {inWorkspace ? null : <AppHeader />}
            <ConnectionBanner />
            <SessionBanner />
            <main
              id="main"
              tabIndex={-1}
              className={inWorkspace ? 'app-main app-main--flush' : 'app-main'}
            >
              <ErrorBoundary resetKey={location.pathname}>
                <Routes>
                  <Route
                    path="/"
                    element={
                      <Titled parts={[status === 'authenticated' && 'Projects']}>
                        <HomePage />
                      </Titled>
                    }
                  />
                  <Route
                    path="/status"
                    element={
                      <RequireAuth>
                        <SystemStatusPage />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/login"
                    element={
                      <Titled parts={['Sign in']}>
                        <LoginPage />
                      </Titled>
                    }
                  />
                  <Route
                    path="/register"
                    element={
                      <Titled parts={['Create your account']}>
                        <RegisterPage />
                      </Titled>
                    }
                  />
                  <Route
                    path="/forgot-password"
                    element={
                      <Titled parts={['Forgot your password']}>
                        <ForgotPasswordPage />
                      </Titled>
                    }
                  />
                  <Route
                    path="/reset-password"
                    element={
                      <Titled parts={['Reset your password']}>
                        <ResetPasswordPage />
                      </Titled>
                    }
                  />
                  <Route
                    path="/verify-email"
                    element={
                      <Titled parts={['Confirm your email']}>
                        <VerifyEmailPage />
                      </Titled>
                    }
                  />
                  <Route
                    path="/operations/*"
                    element={
                      <RequireAuth>
                        <Titled parts={['Operations']}>
                          <OperationsPage />
                        </Titled>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/account/*"
                    element={
                      <RequireAuth>
                        <Titled parts={['Account']}>
                          <AccountPage />
                        </Titled>
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
                    path="/projects/:projectId/settings/*"
                    element={
                      <RequireAuth>
                        <ProjectSettingsPage />
                      </RequireAuth>
                    }
                  />
                  {Gallery ? (
                    <Route
                      path="/__ui"
                      element={
                        <Suspense fallback={<PageSkeleton />}>
                          <Gallery />
                        </Suspense>
                      }
                    />
                  ) : null}
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </ErrorBoundary>
            </main>
          </div>
        </NavigationGuardProvider>
      </ShellBannerProvider>
    </UiProvider>
  );
}
