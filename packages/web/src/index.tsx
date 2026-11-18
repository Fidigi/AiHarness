// ============================================================
// Web App - Main Entry Point
// ============================================================

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { I18nProvider } from './hooks/useI18n';
import { navigationBasename } from './services/navigation-base';
import './themes.css';
import './index.css';
import './agent.css';
import './terminal.css';

// Root is already canonical; leave opt-in prefix normalization out of root builds.
const basename = import.meta.env.BASE_URL === '/' ? '/' : navigationBasename(import.meta.env.BASE_URL);
const application = <App />;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      {/* Zustand publishes view identity synchronously; the router must not leave
          an old route epoch mounted behind an already updated browser URL. */}
      {basename === '/' ? <BrowserRouter useTransitions={false}>
        {application}
      </BrowserRouter> : <BrowserRouter basename={basename} useTransitions={false}>
        {application}
      </BrowserRouter>}
    </I18nProvider>
  </React.StrictMode>,
);
