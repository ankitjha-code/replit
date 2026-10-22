// First, before any module that defines a schema. See the file.
import './strict-csp.js';
import { initTheme } from './theme/theme.js';
// Stylesheets before App: cascade layers take their order from the first
// stylesheet that names them, which must be base.css.
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { AuthProvider } from './lib/auth-context.js';

// Before the first paint, so a stored light choice never flashes dark.
initTheme();

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

// index.html paints the body dark inline so nothing flashes white before the
// stylesheets arrive. They have arrived by now, and an inline style would beat
// the light theme's background for ever, so the placeholder goes.
document.body.removeAttribute('style');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
