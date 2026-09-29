import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError, type User } from '../api';
import { EMPTY_PHONE, PhoneField } from '../components/PhoneField';
import { formatPhone, toE164 } from '../phone';
import { useSession } from '../session';

/**
 * Вход и регистрация — одним путём, как в Телеграме: номер → код из SMS →
 * дальше либо сразу внутрь, либо пароль (двухэтапная проверка), либо логин и
 * имя для нового номера. Отдельной «регистрации» нет: новый номер и есть она.
 *
 * Старые аккаунты, созданные до входа по номеру, входят и по логину с паролем —
 * это отдельная ссылка под формой.
 */

type Step =
  | { kind: 'phone' }
  | { kind: 'code'; phone: string; resendAt: number; demoCode?: string }
  | { kind: 'signup'; phone: string; ticket: string }
  | { kind: 'password'; phone: string; ticket: string }
  | { kind: 'legacy' };

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Не получилось. Попробуйте ещё раз.');

export function Auth({ mode }: { mode: 'login' | 'register' }) {
  const { user, ready, setUser } = useSession();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ kind: 'phone' });

  if (ready && user) return <Navigate to="/" replace />;

  const done = (u: User) => {
    setUser(u);
    navigate('/', { replace: true });
  };

  return (
    <div className="center">
      <div className="auth">
        <span className="wordmark">хроника</span>
        {step.kind === 'phone' && (
          <p className="auth-lede">
            {mode === 'register'
              ? 'Регистрация — по номеру телефона: пришлём код в SMS, и аккаунт готов.'
              : 'Войдите по номеру телефона — пришлём код в SMS. Нового номера ещё нет? Это и есть регистрация.'}
          </p>
        )}

        {step.kind === 'phone' && (
          <PhoneStep onSent={(phone, resendIn, demoCode) => setStep({ kind: 'code', phone, resendAt: Date.now() + resendIn * 1000, demoCode })} />
        )}
        {step.kind === 'code' && (
          <CodeStep
            step={step}
            onBack={() => setStep({ kind: 'phone' })}
            onResent={(resendIn, demoCode) => setStep({ ...step, resendAt: Date.now() + resendIn * 1000, demoCode })}
            onVerdict={(v) => {
              if (v.status === 'signed-in') done(v.user);
              else setStep({ kind: v.status, phone: step.phone, ticket: v.ticket });
            }}
          />
        )}
        {step.kind === 'signup' && <SignupStep step={step} onDone={done} />}
        {step.kind === 'password' && <PasswordStep step={step} onDone={done} onRestart={() => setStep({ kind: 'phone' })} />}
        {step.kind === 'legacy' && <LegacyLogin onDone={done} />}

        <p className="auth-switch">
          {step.kind === 'legacy' ? (
            <button className="btn link" type="button" onClick={() => setStep({ kind: 'phone' })}>
              Войти по номеру телефона
            </button>
          ) : step.kind === 'phone' ? (
            <>
              Аккаунт создан до входа по номеру?{' '}
              <button className="btn link" type="button" onClick={() => setStep({ kind: 'legacy' })}>
                Войти по логину и паролю
              </button>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/* ─ Номер ────────────────────────────────────────────────────────────── */

function PhoneStep({ onSent }: { onSent: (phone: string, resendIn: number, demoCode?: string) => void }) {
  const [phone, setPhone] = useState(EMPTY_PHONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.phoneStart(toE164(phone.dial, phone.number));
      onSent(res.phone, res.resendIn, res.demoCode);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {error && <p className="error">{error}</p>}
      <PhoneField value={phone} onChange={setPhone} autoFocus />
      <p className="hint">Можно и целиком, с «+»: тогда код страны слева не важен.</p>
      <button className="btn block" type="submit" disabled={busy}>
        {busy ? 'Отправляю код…' : 'Получить код'}
      </button>
    </form>
  );
}

/* ─ Код ──────────────────────────────────────────────────────────────── */

type CodeProps = {
  step: Extract<Step, { kind: 'code' }>;
  onBack: () => void;
  onResent: (resendIn: number, demoCode?: string) => void;
  onVerdict: (v: Awaited<ReturnType<typeof api.phoneVerify>>) => void;
};

function CodeStep({ step, onBack, onResent, onVerdict }: CodeProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const sent = useRef(false);

  // Обратный отсчёт до «Отправить ещё раз».
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Android Chrome умеет сам подставить код из SMS (WebOTP), если в SMS
  // есть строка «@сайт #код» — её дописывает сервер. Не умеет — ничего.
  useEffect(() => {
    if (!('OTPCredential' in window)) return;
    const abort = new AbortController();
    navigator.credentials
      .get({ otp: { transport: ['sms'] }, signal: abort.signal } as CredentialRequestOptions)
      .then((cred) => {
        const otp = (cred as { code?: string } | null)?.code;
        if (otp) submitCode(otp);
      })
      .catch(() => undefined);
    return () => abort.abort();
    // Слушаем один раз на шаг: код в SMS для этого номера придёт один.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitCode(value: string) {
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    setError(null);
    try {
      onVerdict(await api.phoneVerify(step.phone, value));
    } catch (err) {
      setError(errorText(err));
      setCode('');
      setBusy(false);
      sent.current = false;
    }
  }

  async function resend() {
    setError(null);
    try {
      const res = await api.phoneStart(step.phone);
      onResent(res.resendIn, res.demoCode);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const wait = Math.max(0, Math.ceil((step.resendAt - now) / 1000));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submitCode(code);
      }}
    >
      <p className="auth-lede">
        Код отправлен на <strong>{formatPhone(step.phone)}</strong>.{' '}
        <button className="btn link" type="button" onClick={onBack}>
          Изменить номер
        </button>
      </p>
      {step.demoCode && (
        <p className="auth-demo" role="status">
          В витрине SMS не отправляются — вот ваш код: <strong>{step.demoCode}</strong>
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <label className="field">
        <span>Код из SMS</span>
        <input
          className="code-input"
          value={code}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
            setCode(digits);
            // Шесть цифр — отправляем сами, как в Телеграме.
            if (digits.length === 6) void submitCode(digits);
          }}
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          placeholder="••••••"
          autoFocus
          required
        />
      </label>
      <button className="btn block" type="submit" disabled={busy || code.length !== 6}>
        {busy ? 'Проверяю…' : 'Продолжить'}
      </button>
      <p className="auth-switch">
        {wait > 0 ? (
          `Новый код можно запросить через ${wait} с`
        ) : (
          <button className="btn link" type="button" onClick={() => void resend()}>
            Отправить код ещё раз
          </button>
        )}
      </p>
    </form>
  );
}

/* ─ Новый номер: логин и имя ─────────────────────────────────────────── */

function SignupStep({ step, onDone }: { step: Extract<Step, { kind: 'signup' }>; onDone: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  // Не отмечено: находиться по номеру человек решает сам, а не по умолчанию.
  const [findable, setFindable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone((await api.phoneSignup(step.ticket, username, displayName || username, findable)).user);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="auth-lede">
        Номер <strong>{formatPhone(step.phone)}</strong> подтверждён. Осталось придумать, как вас называть.
      </p>
      {error && <p className="error">{error}</p>}
      <label className="field">
        <span>Имя пользователя</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
        />
      </label>
      <p className="hint">3–20 символов: латиница, цифры и _. По нему вас найдут и упомянут через @.</p>
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
      <label className="choice">
        <input type="checkbox" checked={findable} onChange={(e) => setFindable(e.target.checked)} />
        <span>
          <strong>Находить меня по номеру</strong>
          <span className="choice-hint">Кто знает ваш номер, найдёт вас в поиске. Поменять можно в настройках.</span>
        </span>
      </label>
      <button className="btn block" type="submit" disabled={busy}>
        {busy ? 'Минуту…' : 'Создать аккаунт'}
      </button>
    </form>
  );
}

/* ─ Двухэтапная проверка ─────────────────────────────────────────────── */

type PasswordProps = { step: Extract<Step, { kind: 'password' }>; onDone: (u: User) => void; onRestart: () => void };

function PasswordStep({ step, onDone, onRestart }: PasswordProps) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone((await api.phonePassword(step.ticket, password)).user);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="auth-lede">
        Аккаунт защищён паролем — это вторая ступень после кода для <strong>{formatPhone(step.phone)}</strong>.
      </p>
      {error && (
        <p className="error">
          {error}{' '}
          {/Вход устарел/.test(error) && (
            <button className="btn link" type="button" onClick={onRestart}>
              Начать заново
            </button>
          )}
        </p>
      )}
      <label className="field">
        <span>Пароль</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
      </label>
      <button className="btn block" type="submit" disabled={busy}>
        {busy ? 'Проверяю…' : 'Войти'}
      </button>
    </form>
  );
}

/* ─ Старый вход по логину ────────────────────────────────────────────── */

function LegacyLogin({ onDone }: { onDone: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone((await api.login({ username, password })).user);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="auth-lede">Для аккаунтов, созданных до входа по номеру. Номер к ним можно привязать в настройках.</p>
      {error && <p className="error">{error}</p>}
      <label className="field">
        <span>Имя пользователя</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
        />
      </label>
      <label className="field">
        <span>Пароль</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      <button className="btn block" type="submit" disabled={busy}>
        {busy ? 'Минуту…' : 'Войти'}
      </button>
      <p className="auth-switch">
        <Link to="/forgot-password">Забыли пароль?</Link>
      </p>
    </form>
  );
}
