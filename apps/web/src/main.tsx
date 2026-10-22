import './strict-csp.js';
import { initTheme } from './theme/theme.js';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { AuthProvider } from './lib/auth-context.js';

initTheme();

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

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
