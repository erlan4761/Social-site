import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type AccountSettings, type LastSeenPrivacy, type Session } from '../api';
import { disablePush, enablePush, install, isStandalone, pushState, useInstallAvailable, type PushState } from '../pwa';
import { useSession } from '../session';
import { fullDate, joinedOn, plural } from '../time';

const LAST_SEEN_CHOICES: { value: LastSeenPrivacy; title: string; hint: string }[] = [
  { value: 'all', title: 'Все', hint: 'Собеседники видят «в сети» и «был(а) 5 минут назад».' },
  { value: 'follows', title: 'Мои подписки', hint: 'Время видят только те, на кого подписаны вы.' },
  { value: 'nobody', title: 'Никто', hint: 'Вместо времени собеседники видят «был(а) недавно».' },
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.account().then(setAccount).catch((err) => setError(errorText(err, 'Не удалось загрузить настройки')));
  }, []);

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
                <dd>@{user?.username}</dd>
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
          </section>
        )}

        {account && <Privacy initial={account.lastSeen} />}
        <Password />
        <Device />
        <Sessions />
        <DeleteAccount />
      </div>
    </>
  );
}

/* ─ Время захода ───────────────────────────────────────────────────────── */

function Privacy({ initial }: { initial: LastSeenPrivacy }) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  // Сохраняется сразу, без кнопки: выбор из трёх — не форма, а переключатель.
  async function choose(next: LastSeenPrivacy) {
    const before = value;
    setValue(next);
    setStatus(null);
    try {
      await api.setLastSeen(next);
      setStatus({ ok: true, text: 'Сохранено' });
    } catch (err) {
      setValue(before);
      setStatus({ ok: false, text: errorText(err, 'Не удалось сохранить') });
    }
  }

  return (
    <section className="settings-block" aria-labelledby="settings-privacy">
      <h2 className="settings-title" id="settings-privacy">
        Кто видит, когда я был(а) в сети
      </h2>
      <fieldset className="choices">
        <legend className="sr-only">Кто видит время захода</legend>
        {LAST_SEEN_CHOICES.map((c) => (
          <label key={c.value} className="choice">
            <input
              type="radio"
              name="last-seen"
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
      <p className="settings-note">
        Правило взаимное, как в Телеграме: от кого вы прячете своё время, того время не видите и вы.
      </p>
      {status && (
        <p className={status.ok ? 'settings-status' : 'error'} role="status">
          {status.text}
        </p>
      )}
    </section>
  );
}

/* ─ Пароль ─────────────────────────────────────────────────────────────── */

function Password() {
  const id = useId();
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
      const res = await api.changePassword(current, fresh);
      setCurrent('');
      setFresh('');
      setRepeat('');
      setStatus({
        ok: true,
        text: res.ended
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

  return (
    <section className="settings-block" aria-labelledby="settings-password">
      <h2 className="settings-title" id="settings-password">
        Пароль
      </h2>
      <form className="settings-form" onSubmit={submit}>
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
        <p className="settings-note">Не короче 8 символов. После смены все другие сеансы завершатся.</p>
        {status && (
          <p className={status.ok ? 'settings-status' : 'error'} role="status">
            {status.text}
          </p>
        )}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Сохраняю…' : 'Сменить пароль'}
        </button>
      </form>
    </section>
  );
}

/* ─ Сеансы ─────────────────────────────────────────────────────────────── */

/** «Chrome, Windows» из User-Agent. Точность не нужна — нужно узнать своё. */
export function deviceName(ua: string | null) {
  if (!ua) return 'Неизвестное устройство';
  const browser = /YaBrowser\//.test(ua)
    ? 'Яндекс Браузер'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  if (!browser && !os) return 'Неизвестное устройство';
  return [browser, os].filter(Boolean).join(', ');
}

function Sessions() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
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
                  <span>{s.current ? 'Этот сеанс' : `Вход ${fullDate(s.createdAt)}`}</span>
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

function DeleteAccount() {
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
      {open && <DeleteDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

function DeleteDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { setUser } = useSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await api.deleteAccount(password);
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
        <div className="sheet-foot">
          <button className="btn ghost" type="button" disabled={busy} onClick={() => dialog.current?.close()}>
            Отмена
          </button>
          <button className="btn danger solid" type="submit" disabled={busy || !password}>
            {busy ? 'Удаляю…' : 'Удалить навсегда'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
