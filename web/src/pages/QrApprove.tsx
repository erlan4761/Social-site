import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';

/**
 * Телефон подтверждает вход на компьютере — сюда ведёт QR-код. Подтверждение
 * явное и с названием устройства: подсунутый чужой QR иначе впускал бы в
 * аккаунт того, кто неосторожно навёл камеру.
 */
export function QrApprove() {
  const { token = '' } = useParams();
  const [device, setDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .qrInfo(token)
      .then((r) => !cancelled && setDevice(r.device))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Не удалось открыть запрос'));
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await api.qrApprove({ token });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Вход на другом устройстве</h1>
      {error && <p className="error">{error}</p>}
      {done ? (
        <p className="settings-status" role="status">
          Готово — на устройстве «{device}» открывается ваш аккаунт. Все сеансы — в{' '}
          <Link to="/settings">настройках</Link>.
        </p>
      ) : device ? (
        <section className="qr-approve">
          <p>
            Войти в ваш аккаунт на устройстве <strong>{device}</strong>?
          </p>
          <p className="settings-note">
            Подтверждайте, только если сами открыли вход на своём компьютере. Если QR-код прислал кто-то другой — это
            попытка получить доступ к вашему аккаунту.
          </p>
          <div className="settings-actions">
            <button className="btn" type="button" disabled={busy} onClick={() => void approve()}>
              {busy ? 'Подтверждаю…' : 'Подтвердить вход'}
            </button>
            <Link className="btn ghost" to="/">
              Отмена
            </Link>
          </div>
        </section>
      ) : (
        !error && <p className="empty flush">Открываю запрос…</p>
      )}
    </>
  );
}
