import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useSession } from '../session';

export function Auth({ mode }: { mode: 'login' | 'register' }) {
  const { user, ready, setUser } = useSession();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (ready && user) return <Navigate to="/" replace />;

  const isRegister = mode === 'register';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = isRegister
        ? await api.register({ username, displayName: displayName || username, email, password })
        : await api.login({ username, password });
      setUser(res.user);
      navigate('/', { replace: true });
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
        <p className="auth-lede">
          Место для того, что вы думаете, а не для того, что вы сняли. Только текст, только ваш
          голос.
        </p>

        <form onSubmit={submit}>
          {error && <p className="error">{error}</p>}

          <label className="field">
            <span>Имя пользователя</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>
          {isRegister && <p className="hint">3–20 символов: латиница, цифры и _</p>}

          {isRegister && (
            <label className="field">
              <span>Отображаемое имя</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Как вас показывать в ленте"
                autoComplete="name"
                maxLength={40}
              />
            </label>
          )}

          {isRegister && (
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>
          )}
          {isRegister && <p className="hint">Понадобится, если забудете пароль</p>}

          <label className="field">
            <span>Пароль</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
            />
          </label>
          {isRegister && <p className="hint">Не короче 8 символов</p>}

          <button className="btn block" type="submit" disabled={busy}>
            {busy ? 'Минуту…' : isRegister ? 'Создать аккаунт' : 'Войти'}
          </button>
        </form>

        <p className="auth-switch">
          {isRegister ? 'Уже есть аккаунт? ' : 'Ещё нет аккаунта? '}
          <Link to={isRegister ? '/login' : '/register'}>
            {isRegister ? 'Войти' : 'Зарегистрироваться'}
          </Link>
          {!isRegister && (
            <>
              {' · '}
              <Link to="/forgot-password">Забыли пароль?</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
