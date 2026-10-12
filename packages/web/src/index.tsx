// ============================================================
// Web App - Main Entry Point
// ============================================================

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { I18nProvider } from './hooks/useI18n';
import './index.css';
import './agent.css';
import './terminal.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      {/* Zustand publishes view identity synchronously; the router must not leave
          an old route epoch mounted behind an already updated browser URL. */}
      <BrowserRouter useTransitions={false}>
        <App />
      </BrowserRouter>
    </I18nProvider>
  </React.StrictMode>,
);
