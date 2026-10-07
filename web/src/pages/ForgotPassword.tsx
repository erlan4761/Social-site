import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [demoLink, setDemoLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.forgotPassword(email);
      setSent(res.message);
      setDemoLink(res.demoLink ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div className="auth">
        <span className="wordmark">duet</span>
        <p className="auth-lede">
          Укажите email, с которым регистрировались, — пришлём ссылку для нового пароля.
        </p>

        {sent ? (
          <>
            <p className="hint" style={{ margin: 0 }}>{sent}</p>
            {demoLink && (
              <p className="hint">
                Письма в демо-режиме нет — вот сама ссылка: <Link to={demoLink}>открыть</Link>
              </p>
            )}
          </>
        ) : (
          <form onSubmit={submit}>
            {error && <p className="error">{error}</p>}

            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
                required
              />
            </label>

            <button className="btn block" type="submit" disabled={busy}>
              {busy ? 'Отправляю…' : 'Прислать ссылку'}
            </button>
          </form>
        )}

        <p className="auth-switch">
          <Link to="/login">Вернуться ко входу</Link>
        </p>
      </div>
    </div>
  );
}
