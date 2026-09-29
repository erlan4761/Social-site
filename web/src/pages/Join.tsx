import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type InvitePreview } from '../api';
import { Monogram } from '../components/Monogram';
import { PresenceAvatar } from '../components/chat/status';
import { plural } from '../time';

/**
 * Приглашение в группу по ссылке: название и кто внутри — чтобы решить,
 * вступать ли. Переписка откроется только после вступления.
 */
export function Join() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<{ chat: InvitePreview; member: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .invitePreview(token)
      .then((res) => !cancelled && setInvite(res))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Не удалось открыть приглашение'));
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const { chat } = await api.joinByInvite(token);
      navigate(`/messages/c/${chat.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось вступить');
      setBusy(false);
    }
  }

  const chat = invite?.chat;
  const others = chat ? chat.memberCount - chat.members.length : 0;

  return (
    <>
      <h1 className="page-title">Приглашение в группу</h1>
      {error && <p className="error">{error}</p>}
      {!chat && !error && <p className="empty flush">Открываю приглашение…</p>}
      {!chat && error && (
        <p className="empty flush">
          <Link to="/messages">К чатам</Link>
        </p>
      )}

      {chat && (
        <section className="join-card" aria-labelledby="join-title">
          <Monogram username={chat.title} displayName={chat.title} />
          <h2 className="join-title" id="join-title">
            {chat.title}
          </h2>
          <p className="join-count">
            {chat.memberCount} {plural(chat.memberCount, 'участник', 'участника', 'участников')}
          </p>
          <ul className="join-members">
            {chat.members.map((m) => (
              <li key={m.id}>
                <PresenceAvatar person={m} size="sm" />
                <span>{m.displayName}</span>
              </li>
            ))}
            {others > 0 && <li className="join-more">и ещё {others}</li>}
          </ul>
          {invite.member ? (
            <Link className="btn" to={`/messages/c/${chat.id}`}>
              Вы уже в группе — открыть
            </Link>
          ) : (
            <button className="btn" type="button" disabled={busy} onClick={() => void join()}>
              {busy ? 'Вступаю…' : 'Вступить в группу'}
            </button>
          )}
        </section>
      )}
    </>
  );
}
