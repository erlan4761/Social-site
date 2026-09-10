import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type ChatSummary, type Conversation } from '../api';
import { Monogram } from '../components/Monogram';
import { NewChatDialog } from '../components/NewChatDialog';
import { useSession } from '../session';
import { plural, timeAgo } from '../time';

/** Личная переписка и групповой чат живут в разных пространствах API, но на
 *  этой странице стоят одним списком: разница между ними — дело устройства
 *  сервера, а не человека, который ищет вчерашний разговор. */
type Row =
  | { kind: 'dm'; at: string; item: Conversation }
  | { kind: 'chat'; at: string; item: ChatSummary };

function rows(conversations: Conversation[], chats: ChatSummary[]): Row[] {
  const dm: Row[] = conversations.map((c) => ({
    kind: 'dm',
    at: c.lastMessage.createdAt,
    item: c,
  }));

  // Чат без сообщений сортируется по дате создания — иначе только что
  // созданный чат оказался бы в самом низу списка.
  const group: Row[] = chats.map((c) => ({
    kind: 'chat',
    at: c.lastMessage?.createdAt ?? c.createdAt,
    item: c,
  }));

  return [...dm, ...group].sort((a, b) => b.at.localeCompare(a.at));
}

export function Messages() {
  const { user, refreshBadges } = useSession();
  const [items, setItems] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Два запроса разом: список ЛС и список чатов. Счётчики в сайдбаре
    // обновляет `refreshBadges`, чтобы не расходиться с ним в арифметике.
    // `allSettled`, а не `all`: это два независимых списка, и падение одного
    // не повод прятать второй — страница «Сообщения» должна открываться всегда.
    Promise.allSettled([api.conversations(), api.chats()])
      .then(([dm, chats]) => {
        if (cancelled) return;

        if (dm.status === 'rejected' && chats.status === 'rejected') {
          const err = dm.reason;
          setError(err instanceof ApiError ? err.message : 'Не удалось загрузить');
          return;
        }

        setItems(
          rows(
            dm.status === 'fulfilled' ? dm.value.conversations : [],
            chats.status === 'fulfilled' ? chats.value.chats : [],
          ),
        );
        if (dm.status === 'rejected') setError('Личные переписки не загрузились. Обновите страницу.');
        if (chats.status === 'rejected') setError('Групповые чаты не загрузились. Обновите страницу.');
        refreshBadges();
      });

    return () => {
      cancelled = true;
    };
  }, [refreshBadges]);

  return (
    <>
      <div className="messages-top">
        <h1 className="page-title">Сообщения</h1>
        <button className="btn small" type="button" onClick={() => setCreating(true)}>
          Новый чат
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {items === null ? (
        !error && <p className="empty" style={{ marginLeft: 0 }}>Загружаю…</p>
      ) : items.length === 0 ? (
        <p className="empty" style={{ marginLeft: 0 }}>
          <strong>Переписок пока нет.</strong>
          Откройте чей-нибудь профиль и напишите первым — или соберите общий чат.
        </p>
      ) : (
        <ul className="dialogs">
          {items.map((row) =>
            row.kind === 'dm' ? (
              <li key={`dm-${row.item.user.id}`}>
                <Link className="dialog" to={`/messages/${row.item.user.username}`}>
                  <Monogram
                    username={row.item.user.username}
                    displayName={row.item.user.displayName}
                    avatarUrl={row.item.user.avatarUrl}
                  />

                  <div className="dialog-body">
                    <div className="dialog-head">
                      <span className="dialog-name">{row.item.user.displayName}</span>
                      {/* Кто кого заблокировал — не сообщаем ни здесь, ни в самом
                          диалоге: пометка одинакова для обеих сторон. */}
                      {row.item.blocked && <span className="dialog-flag">блокировка</span>}
                      <time className="dialog-time" dateTime={row.item.lastMessage.createdAt}>
                        {timeAgo(row.item.lastMessage.createdAt)}
                      </time>
                    </div>
                    <p className={row.item.unread > 0 ? 'dialog-last unread' : 'dialog-last'}>
                      {row.item.lastMessage.fromId === user?.id && (
                        <span className="dialog-you">Вы: </span>
                      )}
                      {row.item.lastMessage.body}
                    </p>
                  </div>

                  {row.item.unread > 0 && <span className="badge">{row.item.unread}</span>}
                </Link>
              </li>
            ) : (
              <li key={`chat-${row.item.id}`}>
                <Link className="dialog" to={`/messages/c/${row.item.id}`}>
                  {/* Монограмма по названию чата: у общей переписки нет лица,
                      но есть имя, и по нему список читается так же быстро. */}
                  <Monogram username={row.item.title} displayName={row.item.title} />

                  <div className="dialog-body">
                    <div className="dialog-head">
                      <span className="dialog-name">{row.item.title}</span>
                      <span className="dialog-flag">
                        {row.item.memberCount}{' '}
                        {plural(row.item.memberCount, 'участник', 'участника', 'участников')}
                      </span>
                      <time className="dialog-time" dateTime={row.at}>
                        {timeAgo(row.at)}
                      </time>
                    </div>
                    <p className={row.item.unread > 0 ? 'dialog-last unread' : 'dialog-last'}>
                      {row.item.lastMessage ? (
                        <>
                          <span className="dialog-you">
                            {row.item.lastMessage.author.id === user?.id
                              ? 'Вы: '
                              : `${row.item.lastMessage.author.displayName}: `}
                          </span>
                          {row.item.lastMessage.body}
                        </>
                      ) : (
                        'Пока ни одного сообщения'
                      )}
                    </p>
                  </div>

                  {row.item.unread > 0 && <span className="badge">{row.item.unread}</span>}
                </Link>
              </li>
            ),
          )}
        </ul>
      )}

      {creating && <NewChatDialog onClose={() => setCreating(false)} />}
    </>
  );
}
