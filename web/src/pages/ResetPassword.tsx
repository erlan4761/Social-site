import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';

type Status = 'checking' | 'valid' | 'invalid' | 'done';

export function ResetPassword() {
  const { token = '' } = useParams();
  const [status, setStatus] = useState<Status>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .checkResetToken(token)
      .then((res) => !cancelled && setStatus(res.valid ? 'valid' : 'invalid'))
      .catch(() => !cancelled && setStatus('invalid'));
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setStatus('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div className="auth">
        <span className="wordmark">хроника</span>

        {status === 'checking' && <p className="auth-lede">Проверяю ссылку…</p>}

        {status === 'invalid' && (
          <>
            <p className="auth-lede">
              Ссылка недействительна или уже использована — они живут 30 минут.
            </p>
            <p className="auth-switch">
              <Link to="/forgot-password">Запросить новую</Link>
            </p>
          </>
        )}

        {status === 'done' && (
          <>
            <p className="auth-lede">Пароль обновлён. Прежние сеансы входа завершены.</p>
            <p className="auth-switch">
              <Link to="/login">Войти с новым паролем</Link>
            </p>
          </>
        )}

        {status === 'valid' && (
          <>
            <p className="auth-lede">Придумайте новый пароль.</p>
            <form onSubmit={submit}>
              {error && <p className="error">{error}</p>}

              <label className="field">
                <span>Новый пароль</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  required
                />
              </label>
              <p className="hint">Не короче 8 символов</p>

              <button className="btn block" type="submit" disabled={busy}>
                {busy ? 'Сохраняю…' : 'Сохранить пароль'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
