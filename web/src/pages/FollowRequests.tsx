import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type FollowRequest } from '../api';
import { Monogram } from '../components/Monogram';
import { timeAgo } from '../time';

/**
 * Заявки на подписку — у закрытого профиля. «Принять» — человек становится
 * подписчиком и узнаёт об этом; «Отклонить» — заявка тихо исчезает: об отказе,
 * как и везде, не сообщают.
 */
export function FollowRequests() {
  const [list, setList] = useState<FollowRequest[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .followRequests()
      .then((res) => {
        if (!cancelled) setList(res.users);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить заявки');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function answer(p: FollowRequest, accept: boolean) {
    setBusy(p.id);
    setError(null);
    try {
      if (accept) await api.acceptFollowRequest(p.username);
      else await api.declineFollowRequest(p.username);
      setList((prev) => prev?.filter((x) => x.id !== p.id) ?? prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось ответить на заявку');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="events-top">
        <h1 className="page-title">Заявки на подписку</h1>
        <Link className="btn ghost small" to="/settings">
          Настройки
        </Link>
      </div>

      <p className="page-lede">
        Профиль закрыт: записи видят только те, чью заявку вы приняли. Отклонённый об отказе не узнает.
      </p>

      {error && <p className="error">{error}</p>}

      {list === null ? (
        !error && <p className="empty">Загружаю…</p>
      ) : list.length === 0 ? (
        <p className="empty">
          <strong>Новых заявок нет.</strong>
          Когда кто-то попросит подписаться, он появится здесь.
        </p>
      ) : (
        <ul className="follow-people requests">
          {list.map((p) => (
            <li key={p.id}>
              <Link className="follow-person" to={`/u/${p.username}`}>
                <Monogram username={p.username} displayName={p.displayName} avatarUrl={p.avatarUrl} size="sm" />
                <span className="follow-who">
                  <strong>{p.displayName}</strong>
                  <span>
                    @{p.username}, {timeAgo(p.requestedAt)}
                  </span>
                  {p.bio && <span className="follow-bio">{p.bio}</span>}
                </span>
              </Link>
              <button className="btn small" type="button" disabled={busy === p.id} onClick={() => void answer(p, true)}>
                Принять
              </button>
              <button
                className="btn ghost small"
                type="button"
                disabled={busy === p.id}
                aria-label={`Отклонить заявку ${p.displayName}`}
                onClick={() => void answer(p, false)}
              >
                Отклонить
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
