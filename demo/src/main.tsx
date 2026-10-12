import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../packages/web/src/hooks/useI18n';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<I18nProvider><App /></I18nProvider>);
