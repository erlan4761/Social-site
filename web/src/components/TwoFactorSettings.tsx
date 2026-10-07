import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, type AccountSettings } from '../api';
import { QrCode } from './QrCode';

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Ключ для ручного ввода — четвёрками, как его печатают приложения. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

type Stage =
  | { kind: 'idle' }
  | { kind: 'password' }
  | { kind: 'scan'; secret: string; uri: string }
  | { kind: 'codes'; codes: string[]; fresh: boolean }
  | { kind: 'regen' }
  | { kind: 'disable' };

/**
 * «Вход с кодом из приложения» в настройках: подключить (QR и первый код),
 * резервные коды один раз на экране, новые коды, отключить. Подключение
 * подтверждается первым кодом — опечатка в ключе не закроет вход навсегда.
 */
export function TwoFactorSettings({ account, onChange }: { account: AccountSettings; onChange: () => void }) {
  const id = useId();
  const on = account.twoFactor.enabled;
  const left = account.twoFactor.backupCodesLeft ?? 0;
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStage({ kind: 'idle' });
    setPassword('');
    setCode('');
    setError(null);
  };

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const begin = (e?: FormEvent) => {
    e?.preventDefault();
    void run(async () => {
      const res = await api.twoFactorSetup(account.hasPassword ? password : undefined);
      setPassword('');
      setStage({ kind: 'scan', ...res });
    }, 'Не удалось начать подключение');
  };

  const enable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api.twoFactorEnable(code);
      setCode('');
      setStage({ kind: 'codes', codes: res.backupCodes, fresh: true });
      onChange();
    }, 'Не удалось включить');
  };

  const regen = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api.twoFactorBackupCodes(code);
      setCode('');
      setStage({ kind: 'codes', codes: res.backupCodes, fresh: false });
      onChange();
    }, 'Не удалось выпустить коды');
  };

  const disable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.twoFactorDisable(account.hasPassword ? password : undefined, code);
      reset();
      onChange();
    }, 'Не удалось отключить');
  };

  const codeField = (label: string, allowBackup: boolean) => (
    <label className="field" htmlFor={`${id}-code`}>
      <span>{label}</span>
      <input
        id={`${id}-code`}
        className="code-input"
        inputMode={allowBackup ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        maxLength={allowBackup ? 9 : 6}
        value={code}
        required
        autoFocus
        onChange={(e) => setCode(allowBackup ? e.target.value : e.target.value.replace(/\D/g, ''))}
      />
    </label>
  );

  const passwordField = account.hasPassword && (
    <label className="field" htmlFor={`${id}-password`}>
      <span>Пароль</span>
      <input
        id={`${id}-password`}
        type="password"
        autoComplete="current-password"
        value={password}
        required
        onChange={(e) => setPassword(e.target.value)}
      />
    </label>
  );

  return (
    <section className="settings-block" aria-labelledby={`${id}-title`}>
      <h2 className="settings-title" id={`${id}-title`}>
        Вход с кодом из приложения
      </h2>

      {stage.kind === 'idle' && (
        <>
          <p className="settings-note">
            {on
              ? `Включён: при входе, кроме ${account.passwordLogin ? 'пароля' : 'кода из SMS'}, спрашивается шестизначный код из приложения-аутентификатора.`
              : 'Кроме пароля или кода из SMS, при входе понадобится шестизначный код из приложения-аутентификатора — Google Authenticator, «Яндекс Ключ», 1Password или другого. Украденного пароля или перехваченной SMS станет мало.'}
          </p>
          {on && (
            <p className={left <= 3 ? 'error' : 'settings-note'}>
              Резервных кодов осталось: {left}.{left <= 3 && ' Выпустите новые, пока есть чем войти.'}
            </p>
          )}
          <div className="settings-actions">
            {on ? (
              <>
                <button className="btn ghost" type="button" onClick={() => setStage({ kind: 'regen' })}>
                  Новые резервные коды
                </button>
                <button className="btn ghost" type="button" onClick={() => setStage({ kind: 'disable' })}>
                  Отключить
                </button>
              </>
            ) : (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => (account.hasPassword ? setStage({ kind: 'password' }) : begin())}
              >
                Подключить
              </button>
            )}
          </div>
        </>
      )}

      {stage.kind === 'password' && (
        <form className="settings-form" onSubmit={begin}>
          <p className="settings-note">Сначала — пароль: открытая чужая вкладка не должна включать проверку за вас.</p>
          {passwordField}
          {error && <p className="error">{error}</p>}
          <div className="settings-actions">
            <button className="btn" type="submit" disabled={busy}>
              Дальше
            </button>
            <button className="btn ghost" type="button" onClick={reset}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {stage.kind === 'scan' && (
        <form className="settings-form" onSubmit={enable}>
          <ol className="totp-steps">
            <li>Откройте приложение-аутентификатор и добавьте аккаунт по QR-коду.</li>
            <li>Введите шесть цифр, которые оно покажет для Duet.</li>
          </ol>
          <div className="totp-qr">
            <QrCode text={stage.uri} label="QR-код для приложения-аутентификатора" />
          </div>
          <p className="settings-note">
            Не сканируется? Добавьте вручную, ключ: <code className="totp-secret">{grouped(stage.secret)}</code>
          </p>
          {codeField('Код из приложения', false)}
          {error && <p className="error">{error}</p>}
          <div className="settings-actions">
            <button className="btn" type="submit" disabled={busy || code.length !== 6}>
              Включить
            </button>
            <button className="btn ghost" type="button" onClick={reset}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {stage.kind === 'codes' && (
        <div className="settings-form">
          <p className="settings-status" role="status">
            {stage.fresh ? 'Вход с кодом включён.' : 'Новые резервные коды выпущены, прежние больше не действуют.'}
          </p>
          <p className="settings-note">
            Резервные коды — на случай, если телефон потеряется: каждый пускает в аккаунт один раз. Сохраните их сейчас —
            больше они не покажутся.
          </p>
          <ol className="backup-codes">
            {stage.codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
          <div className="settings-actions">
            <button className="btn ghost" type="button" onClick={() => void navigator.clipboard?.writeText(stage.codes.join('\n'))}>
              Скопировать
            </button>
            <button className="btn ghost" type="button" onClick={() => saveCodes(stage.codes)}>
              Скачать .txt
            </button>
            <button className="btn" type="button" onClick={reset}>
              Готово
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'regen' && (
        <form className="settings-form" onSubmit={regen}>
          <p className="settings-note">Прежние резервные коды перестанут действовать.</p>
          {codeField('Код из приложения или резервный', true)}
          {error && <p className="error">{error}</p>}
          <div className="settings-actions">
            <button className="btn" type="submit" disabled={busy}>
              Выпустить новые
            </button>
            <button className="btn ghost" type="button" onClick={reset}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {stage.kind === 'disable' && (
        <form className="settings-form" onSubmit={disable}>
          <p className="settings-note">
            Чтобы отключить, нужны {account.hasPassword ? 'пароль и ' : ''}код: одной открытой вкладки для этого мало.
          </p>
          {passwordField}
          {codeField('Код из приложения или резервный', true)}
          {error && <p className="error">{error}</p>}
          <div className="settings-actions">
            <button className="btn danger" type="submit" disabled={busy}>
              Отключить
            </button>
            <button className="btn ghost" type="button" onClick={reset}>
              Отмена
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Коды — файлом: его кладут туда же, где хранят остальное важное. */
function saveCodes(codes: string[]) {
  const text = [
    'Duet — резервные коды для входа',
    'Каждый код действует один раз. Храните их там, где их не найдут посторонние.',
    '',
    ...codes,
    '',
  ].join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'duet-backup-codes.txt';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
