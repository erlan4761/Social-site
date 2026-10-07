import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { deviceName } from '../device';
import { api, ApiError, type AccountSettings, type LastSeenPrivacy, type Privacy, type Session } from '../api';
import { disablePush, enablePush, install, isStandalone, pushState, useInstallAvailable, type PushState } from '../pwa';
import { useSession } from '../session';
import { EMPTY_PHONE, PhoneField } from '../components/PhoneField';
import { formatPhone, toE164 } from '../phone';
import { TwoFactorSettings } from '../components/TwoFactorSettings';
import { fullDate, joinedOn, plural, timeAgo } from '../time';

type Choice = { value: LastSeenPrivacy; title: string; hint: string };

const LAST_SEEN_CHOICES: Choice[] = [
  { value: 'all', title: 'Все', hint: 'Собеседники видят «в сети» и «был(а) 5 минут назад».' },
  { value: 'follows', title: 'Мои подписки', hint: 'Время видят только те, на кого подписаны вы.' },
  { value: 'nobody', title: 'Никто', hint: 'Вместо времени собеседники видят «был(а) недавно».' },
];

const PHONE_FIND_CHOICES: Choice[] = [
  { value: 'all', title: 'Все', hint: 'Кто знает ваш номер целиком, найдёт вас в поиске и сможет написать.' },
  { value: 'follows', title: 'Мои подписки', hint: 'Найдут только те, на кого подписаны вы.' },
  { value: 'nobody', title: 'Никто', hint: 'По номеру вас не найти — только по имени и логину.' },
];

const PHONE_SHOW_CHOICES: Choice[] = [
  { value: 'all', title: 'Все', hint: 'Номер виден в профиле всем, кто вошёл в Хронику. Гостям — никогда.' },
  { value: 'follows', title: 'Мои подписки', hint: 'Номер в профиле видят только те, на кого подписаны вы.' },
  { value: 'nobody', title: 'Никто', hint: 'Номер не виден никому.' },
];

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * Настройки аккаунта: кто видит время захода, пароль, открытые сеансы и
 * удаление. Профиль (имя, «о себе», аватар) правится на странице профиля —
 * там его и видно, и отсюда туда ведёт ссылка.
 */
export function Settings() {
  const { user } = useSession();
  const [account, setAccount] = useState<AccountSettings | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.account().then(setAccount).catch((err) => setError(errorText(err, 'Не удалось загрузить настройки')));
  }, []);
  useEffect(reload, [reload]);

  return (
    <>
      <div className="events-top">
        <h1 className="page-title">Настройки</h1>
        {user && (
          <Link className="btn ghost small" to={`/u/${user.username}`}>
            Имя и аватар — в профиле
          </Link>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="settings">
        {account && (
          <section className="settings-block" aria-labelledby="settings-account">
            <h2 className="settings-title" id="settings-account">
              Аккаунт
            </h2>
            <dl className="settings-facts">
              <div>
                <dt>Логин</dt>
                <dd>
                  @{user?.username}{' '}
                  {!renaming && (
                    <button className="btn link" type="button" onClick={() => setRenaming(true)}>
                      Изменить
                    </button>
                  )}
                </dd>
              </div>
              <div>
                <dt>Телефон</dt>
                <dd>{account.phone ? formatPhone(account.phone) : 'не привязан'}</dd>
              </div>
              <div>
                <dt>Почта</dt>
                <dd>{account.email ?? 'не указана'}</dd>
              </div>
              <div>
                <dt>С нами с</dt>
                <dd>{joinedOn(account.createdAt)}</dd>
              </div>
            </dl>
            {renaming && <UsernameForm onDone={() => setRenaming(false)} />}
          </section>
        )}

        {account && <PhoneBlock account={account} onChange={reload} />}
        {account && <PrivateProfile initial={Boolean(account.privateProfile)} />}
        {account && (
          <PrivacyChoice
            field="lastSeen"
            title="Кто видит, когда я был(а) в сети"
            choices={LAST_SEEN_CHOICES}
            initial={account.lastSeen}
            note="Правило взаимное, как в Телеграме: от кого вы прячете своё время, того время не видите и вы."
          />
        )}
        {account?.phone && (
          <PrivacyChoice
            field="phoneFind"
            title="Кто может найти меня по номеру"
            choices={PHONE_FIND_CHOICES}
            initial={account.phoneFind}
            note="Номер ищется только целиком — по кусочку не найти. Пока вы сами не разрешили, по номеру вас не находят."
          />
        )}
        {account?.phone && (
          <PrivacyChoice
            field="phoneShow"
            title="Кто видит мой номер"
            choices={PHONE_SHOW_CHOICES}
            initial={account.phoneShow}
          />
        )}
        {account && <Password account={account} onChange={reload} />}
        {account && <TwoFactorSettings account={account} onChange={reload} />}
        <Device />
        <Sessions account={account} onAccountChange={reload} />
        <MyData />
        {account && <DeleteAccount account={account} />}
      </div>
    </>
  );
}

/* ─ Логин ──────────────────────────────────────────────────────────────── */

/**
 * Сменить логин. Старый две недели закреплён за вами: занять его никто не
 * сможет, а вы — вернуться к нему. Упоминания в старых сообщениях и старые
 * ссылки на профиль ведут в никуда — как в Телеграме.
 */
function UsernameForm({ onDone }: { onDone: () => void }) {
  const { user, setUser } = useSession();
  const [value, setValue] = useState(user?.username ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.changeUsername(value.trim());
      setUser(res.user);
      setDone(`Готово: теперь вы @${res.user.username}. Прежний логин @${res.previous} ещё ${res.holdDays} дней закреплён за вами — занять его никто не сможет.`);
    } catch (err) {
      setError(errorText(err, 'Не удалось сменить логин'));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="settings-form">
        <p className="settings-status" role="status">{done}</p>
        <button className="btn ghost small" type="button" onClick={onDone}>
          Закрыть
        </button>
      </div>
    );
  }

  return (
    <form className="settings-form" onSubmit={submit}>
      {error && <p className="error">{error}</p>}
      <label className="field">
        <span>Новый логин</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={20}
          autoFocus
          required
        />
      </label>
      <p className="settings-note">
        3–20 символов: латиница, цифры и _. Входить по логину (если вы входите по нему) нужно будет уже с новым.
      </p>
      <div className="settings-actions">
        <button className="btn" type="submit" disabled={busy || !value.trim()}>
          {busy ? 'Сохраняю…' : 'Сменить логин'}
        </button>
        <button className="btn ghost" type="button" onClick={onDone}>
          Отмена
        </button>
      </div>
    </form>
  );
}

/* ─ Номер телефона ─────────────────────────────────────────────────────── */

function PhoneBlock({ account, onChange }: { account: AccountSettings; onChange: () => void }) {
  const [step, setStep] = useState<'idle' | 'phone' | 'code'>('idle');
  const [phone, setPhone] = useState(EMPTY_PHONE);
  const [target, setTarget] = useState('');
  const [demoCode, setDemoCode] = useState<string | undefined>(undefined);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, 'Не получилось'));
    } finally {
      setBusy(false);
    }
  }

  const sendCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api.linkPhoneStart(toE164(phone.dial, phone.number));
      setTarget(res.phone);
      setDemoCode(res.demoCode);
      setCode('');
      setStep('code');
    });
  };

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.linkPhone(target, code);
      setStep('idle');
      onChange();
    });
  };

  return (
    <section className="settings-block" aria-labelledby="settings-phone">
      <h2 className="settings-title" id="settings-phone">
        Номер телефона
      </h2>
      <p className="settings-note">
        {account.phone
          ? account.passwordLogin
            ? `Привязан ${formatPhone(account.phone)}: входить можно и по нему, как в Телеграме, — вторым шагом спросят пароль.`
            : `${formatPhone(account.phone)} — ваш вход в аккаунт. Его можно сменить на другой, но не убрать.`
          : 'Привяжите номер — сможете входить по нему кодом из SMS, как в Телеграме.'}
      </p>
      {error && <p className="error">{error}</p>}

      {step === 'idle' && (
        <div className="settings-actions">
          <button className="btn ghost" type="button" onClick={() => setStep('phone')}>
            {account.phone ? 'Сменить номер' : 'Привязать номер'}
          </button>
          {account.phone && account.passwordLogin && (
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(async () => {
              await api.unlinkPhone();
              onChange();
            })}>
              Отвязать
            </button>
          )}
        </div>
      )}

      {step === 'phone' && (
        <form className="settings-form" onSubmit={sendCode}>
          <PhoneField value={phone} onChange={setPhone} label="Новый номер" autoFocus />
          <div className="settings-actions">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Отправляю код…' : 'Получить код'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setStep('idle')}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {step === 'code' && (
        <form className="settings-form" onSubmit={confirm}>
          <p className="settings-note">Код отправлен на {formatPhone(target)}.</p>
          {demoCode && (
            <p className="auth-demo" role="status">
              В витрине SMS не отправляются — вот код: <strong>{demoCode}</strong>
            </p>
          )}
          <label className="field">
            <span>Код из SMS</span>
            <input
              className="code-input"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              required
            />
          </label>
          <div className="settings-actions">
            <button className="btn" type="submit" disabled={busy || code.length !== 6}>
              {busy ? 'Проверяю…' : 'Подтвердить'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setStep('phone')}>
              Другой номер
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/* ─ Закрытый профиль ─────────────────────────────────────────────────────── */

/**
 * Открытый или закрытый профиль. Закрыть — нынешние подписчики остаются, новые
 * приходят заявками. Открыть — все ждущие заявки принимаются: держать их незачем.
 */
function PrivateProfile({ initial }: { initial: boolean }) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  async function choose(next: boolean) {
    const before = value;
    setValue(next);
    setStatus(null);
    try {
      const res = await api.setPrivateProfile(next);
      setStatus({
        ok: true,
        text: res.accepted > 0 ? `Сохранено. Ждавшие заявки приняты: ${res.accepted}` : 'Сохранено',
      });
    } catch (err) {
      setValue(before);
      setStatus({ ok: false, text: errorText(err, 'Не удалось сохранить') });
    }
  }

  return (
    <section className="settings-block" aria-labelledby="settings-private">
      <h2 className="settings-title" id="settings-private">
        Кто видит мои записи
      </h2>
      <fieldset className="choices">
        <legend className="sr-only">Кто видит мои записи</legend>
        <label className="choice">
          <input type="radio" name="private-profile" checked={!value} onChange={() => void choose(false)} />
          <span>
            <strong>Все</strong>
            <span className="choice-hint">Открытый профиль: подписаться может любой.</span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="private-profile" checked={value} onChange={() => void choose(true)} />
          <span>
            <strong>Только подписчики</strong>
            <span className="choice-hint">Закрытый профиль: подписка — по заявке, которую вы принимаете.</span>
          </span>
        </label>
      </fieldset>
      <p className="settings-note">
        Имя, «о себе» и число записей видны всем. Записи закрытого профиля нельзя репостить и цитировать.
        {value && (
          <>
            {' '}
            <Link to="/requests">Заявки на подписку</Link>
          </>
        )}
      </p>
      {status && (
        <p className={status.ok ? 'settings-status' : 'error'} role="status">
          {status.text}
        </p>
      )}
    </section>
  );
}

/* ─ Приватность: время захода и номер ─────────────────────────────────────── */

type PrivacyProps = {
  field: keyof Privacy;
  title: string;
  choices: Choice[];
  initial: LastSeenPrivacy;
  note?: string;
};

function PrivacyChoice({ field, title, choices, initial, note }: PrivacyProps) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  // Сохраняется сразу, без кнопки: выбор из трёх — не форма, а переключатель.
  async function choose(next: LastSeenPrivacy) {
    const before = value;
    setValue(next);
    setStatus(null);
    try {
      await api.setPrivacy({ [field]: next });
      setStatus({ ok: true, text: 'Сохранено' });
    } catch (err) {
      setValue(before);
      setStatus({ ok: false, text: errorText(err, 'Не удалось сохранить') });
    }
  }

  return (
    <section className="settings-block" aria-labelledby={`settings-${field}`}>
      <h2 className="settings-title" id={`settings-${field}`}>
        {title}
      </h2>
      <fieldset className="choices">
        <legend className="sr-only">{title}</legend>
        {choices.map((c) => (
          <label key={c.value} className="choice">
            <input
              type="radio"
              name={field}
              value={c.value}
              checked={value === c.value}
              onChange={() => void choose(c.value)}
            />
            <span>
              <strong>{c.title}</strong>
              <span className="choice-hint">{c.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {note && <p className="settings-note">{note}</p>}
      {status && (
        <p className={status.ok ? 'settings-status' : 'error'} role="status">
          {status.text}
        </p>
      )}
    </section>
  );
}

/* ─ Пароль ─────────────────────────────────────────────────────────────── */

function Password({ account, onChange }: { account: AccountSettings; onChange: () => void }) {
  const id = useId();
  // У аккаунта по номеру пароль — двухэтапная проверка: его можно не иметь,
  // задать без текущего и выключить. У старого — это вход, он есть всегда.
  const twoStep = !account.passwordLogin;
  const needsCurrent = account.hasPassword;
  const [current, setCurrent] = useState('');
  const [fresh, setFresh] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (fresh !== repeat) {
      setStatus({ ok: false, text: 'Новый пароль и повтор не совпадают' });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.changePassword(needsCurrent ? current : '', fresh);
      setCurrent('');
      setFresh('');
      setRepeat('');
      onChange();
      setStatus({
        ok: true,
        text: !needsCurrent
          ? 'Двухэтапная проверка включена: после кода из SMS теперь спросят этот пароль.'
          : res.ended
          ? `Пароль сменён. ${plural(res.ended, 'Завершён', 'Завершены', 'Завершено')} ${res.ended} ${plural(res.ended, 'другой сеанс', 'других сеанса', 'других сеансов')}.`
          : 'Пароль сменён.',
      });
      window.dispatchEvent(new Event('sessions-changed'));
    } catch (err) {
      setStatus({ ok: false, text: errorText(err, 'Не удалось сменить пароль') });
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setStatus(null);
    try {
      await api.removePassword(current);
      setCurrent('');
      onChange();
      setStatus({ ok: true, text: 'Двухэтапная проверка выключена: входить будете по одному коду из SMS.' });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err, 'Не удалось выключить') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-block" aria-labelledby="settings-password">
      <h2 className="settings-title" id="settings-password">
        {twoStep ? 'Двухэтапная проверка' : 'Пароль'}
      </h2>
      {twoStep && (
        <p className="settings-note">
          {account.hasPassword
            ? 'Включена: после кода из SMS спрашивается пароль. Даже с доступом к вашим SMS в аккаунт без него не войти.'
            : 'Выключена. Задайте пароль — и после кода из SMS будут спрашивать ещё и его.'}
        </p>
      )}
      <form className="settings-form" onSubmit={submit}>
        {needsCurrent && (
          <label className="field" htmlFor={`${id}-current`}>
            <span>Текущий пароль</span>
            <input
              id={`${id}-current`}
              type="password"
              autoComplete="current-password"
              value={current}
              required
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
        )}
        <label className="field" htmlFor={`${id}-new`}>
          <span>Новый пароль</span>
          <input
            id={`${id}-new`}
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={fresh}
            required
            onChange={(e) => setFresh(e.target.value)}
          />
        </label>
        <label className="field" htmlFor={`${id}-repeat`}>
          <span>Новый пароль ещё раз</span>
          <input
            id={`${id}-repeat`}
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={repeat}
            required
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        <p className="settings-note">
          {needsCurrent ? 'Не короче 8 символов. После смены все другие сеансы завершатся.' : 'Не короче 8 символов.'}
        </p>
        {status && (
          <p className={status.ok ? 'settings-status' : 'error'} role="status">
            {status.text}
          </p>
        )}
        <div className="settings-actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Сохраняю…' : needsCurrent ? 'Сменить пароль' : 'Включить проверку'}
          </button>
          {twoStep && account.hasPassword && (
            <button className="btn ghost" type="button" disabled={busy || !current} onClick={() => void turnOff()}>
              Выключить проверку
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

/* ─ Сеансы ─────────────────────────────────────────────────────────────── */

const TTL_CHOICES: { days: number; label: string }[] = [
  { days: 7, label: 'неделю' },
  { days: 30, label: 'месяц' },
  { days: 90, label: 'три месяца' },
  { days: 180, label: 'полгода' },
  { days: 365, label: 'год' },
];

type SessionsProps = { account: AccountSettings | null; onAccountChange: () => void };

function Sessions({ account, onAccountChange }: SessionsProps) {
  const ttlId = useId();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [ttlNote, setTtlNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .sessions()
      .then((res) => setSessions(res.sessions))
      .catch((err) => setError(errorText(err, 'Не удалось загрузить сеансы')));
  }, []);

  useEffect(() => {
    load();
    // Смена пароля завершает другие сеансы — список должен это показать.
    window.addEventListener('sessions-changed', load);
    return () => window.removeEventListener('sessions-changed', load);
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
    } catch (err) {
      setError(errorText(err, 'Не получилось'));
    } finally {
      setBusy(false);
    }
  }

  const others = sessions?.filter((s) => !s.current) ?? [];

  return (
    <section className="settings-block" aria-labelledby="settings-sessions">
      <h2 className="settings-title" id="settings-sessions">
        Где выполнен вход
      </h2>
      {error && <p className="error">{error}</p>}
      {sessions === null ? (
        !error && <p className="settings-note">Загружаю…</p>
      ) : (
        <>
          <ul className="sessions">
            {sessions.map((s) => (
              <li key={s.id} className={s.current ? 'session current' : 'session'}>
                <span className="session-who">
                  <strong>{deviceName(s.userAgent)}</strong>
                  <span title={`Вход ${fullDate(s.createdAt)}`}>
                    {s.current ? 'Этот сеанс' : `Активен ${timeAgo(s.lastUsedAt)}`}
                  </span>
                </span>
                {!s.current && (
                  <button className="btn ghost small" type="button" disabled={busy} onClick={() => void run(() => api.endSession(s.id))}>
                    Завершить
                  </button>
                )}
              </li>
            ))}
          </ul>
          {others.length > 0 ? (
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(() => api.endOtherSessions())}>
              Завершить все другие сеансы
            </button>
          ) : (
            <p className="settings-note">Других сеансов нет — аккаунт открыт только здесь.</p>
          )}
        </>
      )}
      {account && (
        <div className="session-ttl">
          <label className="field" htmlFor={ttlId}>
            <span>Завершать сеанс, если им не пользовались</span>
            <select
              id={ttlId}
              value={account.sessionTtlDays}
              disabled={busy}
              onChange={(e) =>
                void run(async () => {
                  const res = await api.setSessionTtl(Number(e.target.value));
                  setTtlNote(
                    res.ended
                      ? `Закрыто неактивных: ${res.ended}.`
                      : 'Сохранено. Сеансы, которыми не пользуются дольше, закроются сами.',
                  );
                  onAccountChange();
                })
              }
            >
              {TTL_CHOICES.map((c) => (
                <option key={c.days} value={c.days}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {ttlNote && (
            <p className="settings-status" role="status">
              {ttlNote}
            </p>
          )}
        </div>
      )}
      <LinkDevice onLinked={() => window.dispatchEvent(new Event('sessions-changed'))} />
    </section>
  );
}

/**
 * Подключить компьютер по коду — если QR на экране компьютера нечем
 * сфотографировать. Тот же запрос, что по QR: код живёт две минуты.
 */
function LinkDevice({ onLinked }: { onLinked: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const info = await api.qrInfo(code);
      if (!window.confirm(`Войти в ваш аккаунт на устройстве «${info.device}»? Подтверждайте, только если это ваш компьютер.`)) return;
      const res = await api.qrApprove({ code });
      setDone(`Готово: вход на устройстве «${res.device}» подтверждён.`);
      setCode('');
      setOpen(false);
      window.setTimeout(onLinked, 2500);
    } catch (err) {
      setError(errorText(err, 'Не получилось'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="link-device">
      {done && <p className="settings-status" role="status">{done}</p>}
      {open ? (
        <form className="settings-form" onSubmit={submit}>
          {error && <p className="error">{error}</p>}
          <label className="field">
            <span>Код с экрана компьютера</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={9}
              autoFocus
              required
            />
          </label>
          <div className="settings-actions">
            <button className="btn" type="submit" disabled={busy || code.replace(/[^A-Z0-9]/g, '').length !== 8}>
              {busy ? 'Проверяю…' : 'Подключить'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setOpen(false)}>
              Отмена
            </button>
          </div>
        </form>
      ) : (
        <button className="btn ghost" type="button" onClick={() => setOpen(true)}>
          Подключить устройство по коду
        </button>
      )}
    </div>
  );
}

/* ─ Мои данные ────────────────────────────────────────────────────────── */

/**
 * Выгрузка своих данных одним JSON-файлом. Файлы вложений в него не вшиваются:
 * у каждого есть имя и ссылка, по которой их скачивает вошедший владелец.
 */
function MyData() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hronika-${data.profile.username}-${data.exportedAt.slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(errorText(err, 'Не удалось собрать выгрузку'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-block" aria-labelledby="settings-data">
      <h2 className="settings-title" id="settings-data">
        Мои данные
      </h2>
      <p className="settings-note">
        Всё, что вы здесь писали и настроили, одним файлом: профиль, записи и комментарии, отметки и закладки,
        подписки, личные переписки целиком, свои сообщения в группах, свои каналы, папки, черновики и отложенные.
        Паролей и ключей входа в файле нет; чужих сообщений в группах — тоже.
      </p>
      {error && <p className="error">{error}</p>}
      <button className="btn ghost" type="button" disabled={busy} onClick={() => void download()}>
        {busy ? 'Собираю…' : 'Скачать мои данные (JSON)'}
      </button>
    </section>
  );
}

/* ─ Уведомления и приложение ─────────────────────────────────────────── */

const PUSH_NOTES: Record<PushState, string> = {
  unsupported:
    'Этот браузер не умеет пуш-уведомления. На iPhone и iPad они работают, если сначала добавить сайт на экран «Домой» (iOS 16.4 и новее).',
  demo: 'В витрине пуш-уведомлений нет: их присылает сервер, а витрина живёт без него. На полной версии они работают.',
  denied: 'Уведомления для этого сайта запрещены в настройках браузера. Разрешите их там — и кнопка появится здесь.',
  off: 'Сообщения, упоминания и приглашения придут, даже когда вкладка закрыта. Пока сайт открыт, хватает счётчиков — дважды не звеним.',
  on: 'Включены на этом устройстве. Выйдете из аккаунта здесь — уведомления сюда перестанут приходить сами.',
};

function Device() {
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canInstall = useInstallAvailable();
  const standalone = isStandalone();

  useEffect(() => {
    pushState().then(setPush).catch(() => setPush('unsupported'));
  }, []);

  async function toggle(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      setPush(await (on ? enablePush() : disablePush()));
    } catch (err) {
      setError(errorText(err, on ? 'Не удалось включить уведомления' : 'Не удалось выключить уведомления'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-block" aria-labelledby="settings-device">
      <h2 className="settings-title" id="settings-device">
        Уведомления и приложение
      </h2>
      {push && <p className="settings-note">{PUSH_NOTES[push]}</p>}
      {error && <p className="error">{error}</p>}
      <div className="settings-actions">
        {push === 'off' && (
          <button className="btn" type="button" disabled={busy} onClick={() => void toggle(true)}>
            {busy ? 'Включаю…' : 'Включить уведомления'}
          </button>
        )}
        {push === 'on' && (
          <button className="btn ghost" type="button" disabled={busy} onClick={() => void toggle(false)}>
            {busy ? 'Выключаю…' : 'Выключить уведомления'}
          </button>
        )}
        {canInstall && (
          <button className="btn ghost" type="button" onClick={() => void install()}>
            Установить приложение
          </button>
        )}
      </div>
      <p className="settings-note">
        {standalone
          ? 'Открыто как приложение.'
          : canInstall
            ? 'Приложение встанет на рабочий стол или экран «Домой» — отдельным окном, без адресной строки.'
            : 'Поставить как приложение: в Safari — «Поделиться» → «На экран „Домой“», в Chrome и Edge — значок установки в адресной строке.'}
      </p>
    </section>
  );
}

/* ─ Удаление аккаунта ──────────────────────────────────────────────────── */

function DeleteAccount({ account }: { account: AccountSettings }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="settings-block danger" aria-labelledby="settings-delete">
      <h2 className="settings-title" id="settings-delete">
        Удаление аккаунта
      </h2>
      <p className="settings-note">
        Удаляются профиль, записи, комментарии, сообщения, ваши каналы и файлы — навсегда, восстановить их
        нельзя.
      </p>
      <button className="btn danger" type="button" onClick={() => setOpen(true)}>
        Удалить аккаунт…
      </button>
      {open && <DeleteDialog account={account} onClose={() => setOpen(false)} />}
    </section>
  );
}

/** Подтверждение — паролем, а у аккаунта по номеру без пароля — кодом из SMS. */
function DeleteDialog({ account, onClose }: { account: AccountSettings; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { setUser } = useSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState<{ demoCode?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byCode = !account.hasPassword;

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.deleteCode();
      setCodeSent({ demoCode: res.demoCode });
    } catch (err) {
      setError(errorText(err, 'Не удалось отправить код'));
    } finally {
      setBusy(false);
    }
  }

  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    el.showModal();
    const onNativeClose = () => closeHandler.current();
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, []);

  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current && !busy) dialog.current.close();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(byCode ? { code } : { password });
      setUser(null);
      navigate('/login', { replace: true });
    } catch (err) {
      setError(errorText(err, 'Не удалось удалить аккаунт'));
      setBusy(false);
    }
  }

  return (
    <dialog className="sheet" ref={dialog} onClick={backdrop} aria-labelledby={titleId}>
      <form onSubmit={submit}>
        <h2 className="sheet-title" id={titleId}>
          Удалить аккаунт навсегда?
        </h2>
        <ul className="settings-loss">
          <li>профиль, записи и комментарии;</li>
          <li>личные переписки — у собеседников тоже;</li>
          <li>ваши сообщения в группах и ваши каналы;</li>
          <li>все загруженные файлы.</li>
        </ul>
        <p className="settings-note">
          Группы, где остались другие, не пропадут: их владельцем станет самый давний участник.
        </p>
        {error && <p className="error">{error}</p>}
        {byCode ? (
          codeSent ? (
            <>
              {codeSent.demoCode && (
                <p className="auth-demo" role="status">
                  В витрине SMS не отправляются — вот код: <strong>{codeSent.demoCode}</strong>
                </p>
              )}
              <label className="field">
                <span>Код из SMS на {account.phone ? formatPhone(account.phone) : 'ваш номер'}</span>
                <input
                  className="code-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  autoFocus
                  required
                />
              </label>
            </>
          ) : (
            <p className="settings-note">
              Подтвердите удаление кодом из SMS.{' '}
              <button className="btn link" type="button" disabled={busy} onClick={() => void requestCode()}>
                Отправить код
              </button>
            </p>
          )
        ) : (
          <label className="field">
            <span>Пароль — чтобы подтвердить</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              required
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        <div className="sheet-foot">
          <button className="btn ghost" type="button" disabled={busy} onClick={() => dialog.current?.close()}>
            Отмена
          </button>
          <button className="btn danger solid" type="submit" disabled={busy || (byCode ? code.length !== 6 : !password)}>
            {busy ? 'Удаляю…' : 'Удалить навсегда'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
