import { useState, type FormEvent } from 'react';
import { loginWeb } from '../services/api';
import { useI18n } from '../hooks/useI18n';

function LoginView({ onLogin }: { onLogin: () => void }) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    const result = await loginWeb(token);
    setLoading(false);
    if (result.success) onLogin();
    else setError(result.error || t('auth.failed'));
  };

  return (
    <main className="login-view">
      <form onSubmit={submit}>
        <h1>AiHarness</h1>
        <p>{t('auth.description')}</p>
        <label htmlFor="auth-token">{t('auth.token')}</label>
        <input id="auth-token" type="password" autoComplete="current-password" value={token}
          onChange={event => setToken(event.target.value)} autoFocus required />
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="submit" disabled={loading || !token}>{loading ? t('common.loading') : t('auth.login')}</button>
        <small>{t('auth.httpsNotice')}</small>
      </form>
    </main>
  );
}

export default LoginView;
