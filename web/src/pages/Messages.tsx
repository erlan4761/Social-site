import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Conversation } from '../api';
import { Monogram } from '../components/Monogram';
import { useSession } from '../session';
import { timeAgo } from '../time';

export function Messages() {
  const { user, setUnreadTotal } = useSession();
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .conversations()
      .then((res) => {
        if (cancelled) return;
        setItems(res.conversations);
        setUnreadTotal(res.unreadTotal);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить');
      });
    return () => {
      cancelled = true;
    };
  }, [setUnreadTotal]);

  if (error) return <p className="error">{error}</p>;

  return (
    <>
      <h1 className="page-title">Сообщения</h1>

      {items === null ? (
        <p className="empty" style={{ marginLeft: 0 }}>Загружаю…</p>
      ) : items.length === 0 ? (
        <p className="empty" style={{ marginLeft: 0 }}>
          <strong>Переписок пока нет.</strong>
          Откройте чей-нибудь профиль и напишите первым.
        </p>
      ) : (
        <ul className="dialogs">
          {items.map(({ user: other, unread, lastMessage }) => (
            <li key={other.id}>
              <Link className="dialog" to={`/messages/${other.username}`}>
                <Monogram
                  username={other.username}
                  displayName={other.displayName}
                  avatarUrl={other.avatarUrl}
                />

                <div className="dialog-body">
                  <div className="dialog-head">
                    <span className="dialog-name">{other.displayName}</span>
                    <time className="dialog-time" dateTime={lastMessage.createdAt}>
                      {timeAgo(lastMessage.createdAt)}
                    </time>
                  </div>
                  <p className={unread > 0 ? 'dialog-last unread' : 'dialog-last'}>
                    {lastMessage.fromId === user?.id && <span className="dialog-you">Вы: </span>}
                    {lastMessage.body}
                  </p>
                </div>

                {unread > 0 && <span className="badge">{unread}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
