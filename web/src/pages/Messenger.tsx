import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useMatch, useNavigate } from 'react-router-dom';
import { api, ApiError, type Author, type ChatSummary, type Conversation } from '../api';
import { PresenceAvatar, Ticks } from '../components/Chat';
import { Icon } from '../components/Icon';
import { Monogram } from '../components/Monogram';
import { NewChatDialog } from '../components/NewChatDialog';
import { useSession } from '../session';
import { isOnline, listTime, plural } from '../time';

/** Список обновляется сам: в две колонки он всё время на виду, и новое
 *  сообщение из другого чата должно поднять его наверх без перезагрузки. */
const LIST_POLL_MS = 10_000;
/** Поиск людей — после паузы в наборе, а не на каждую букву. */
const PEOPLE_DEBOUNCE_MS = 250;

/** Что получает открытая переписка от мессенджера через `<Outlet context>`. */
export type MessengerContext = { refreshList: () => void };

/** Личная переписка и групповой чат живут в разных пространствах API, но в
 *  списке стоят вперемешку: разница — дело сервера, а не человека, который
 *  ищет вчерашний разговор. */
type Row =
  | { kind: 'dm'; key: string; at: string; name: string; item: Conversation }
  | { kind: 'chat'; key: string; at: string; name: string; item: ChatSummary };

function rows(conversations: Conversation[], chats: ChatSummary[]): Row[] {
  const dm: Row[] = conversations.map((c) => ({
    kind: 'dm',
    key: `dm-${c.user.id}`,
    at: c.lastMessage.createdAt,
    name: c.user.displayName,
    item: c,
  }));
  // Чат без сообщений встаёт по дате создания — иначе только что собранный
  // чат оказался бы в самом низу.
  const group: Row[] = chats.map((c) => ({
    kind: 'chat',
    key: `chat-${c.id}`,
    at: c.lastMessage?.createdAt ?? c.createdAt,
    name: c.title,
    item: c,
  }));
  return [...dm, ...group].sort((a, b) => b.at.localeCompare(a.at));
}

const fold = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');

function matches(row: Row, q: string) {
  if (fold(row.name).includes(q)) return true;
  return row.kind === 'dm' && fold(row.item.user.username).includes(q);
}

export function Messenger() {
  const { user, refreshBadges } = useSession();
  const navigate = useNavigate();
  const open = useMatch('/messages/:first/*') != null;

  const [items, setItems] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Author[]>([]);

  const load = useCallback(() => {
    // allSettled: два независимых списка, падение одного — не повод прятать второй.
    return Promise.allSettled([api.conversations(), api.chats()]).then(([dm, chats]) => {
      if (dm.status === 'rejected' && chats.status === 'rejected') {
        const err = dm.reason;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить чаты');
        return;
      }
      setError(
        dm.status === 'rejected'
          ? 'Личные переписки не загрузились.'
          : chats.status === 'rejected'
            ? 'Групповые чаты не загрузились.'
            : null,
      );
      setItems(
        rows(
          dm.status === 'fulfilled' ? dm.value.conversations : [],
          chats.status === 'fulfilled' ? chats.value.chats : [],
        ),
      );
    });
  }, []);

  const refreshList = useCallback(() => {
    void load();
    refreshBadges();
  }, [load, refreshBadges]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const q = fold(query.trim());
  const shown = useMemo(() => (items && q ? items.filter((r) => matches(r, q)) : items), [items, q]);

  // Глобальный поиск людей — как в Телеграме: набрал имя, и среди результатов
  // есть те, с кем переписки ещё не было.
  useEffect(() => {
    if (q.length < 2) {
      setPeople([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .searchUsers(query.trim())
        .then((res) => {
          if (!cancelled) setPeople(res.users);
        })
        .catch(() => {
          if (!cancelled) setPeople([]);
        });
    }, PEOPLE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, query]);

  const known = new Set(
    (items ?? []).filter((r): r is Extract<Row, { kind: 'dm' }> => r.kind === 'dm').map((r) => r.item.user.id),
  );
  const strangers = people.filter((p) => p.id !== user?.id && !known.has(p.id));

  return (
    <div className="messenger">
      <div className={open ? 'messenger-grid has-open' : 'messenger-grid'}>
        <section className="messenger-list" aria-label="Чаты">
          <div className="list-head">
            <h1 className="list-title">Сообщения</h1>
            <button
              className="icon-btn"
              type="button"
              onClick={() => setCreating(true)}
              aria-label="Новый групповой чат"
              title="Новый групповой чат"
            >
              <Icon name="plus" />
            </button>
          </div>

          <label className="list-search">
            <Icon name="search" size={18} />
            <span className="sr-only">Поиск по чатам и людям</span>
            <input
              type="search"
              value={query}
              placeholder="Поиск"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
              }}
            />
          </label>

          <div className="list-scroll">
            {error && <p className="error list-error">{error}</p>}

            {shown === null ? (
              !error && <p className="list-note">Загружаю…</p>
            ) : items && items.length === 0 && !q ? (
              <p className="list-note">
                <strong>Переписок пока нет.</strong>
                Найдите человека через поиск выше — или соберите общий чат.
              </p>
            ) : (
              <>
                {q && shown.length === 0 && strangers.length === 0 && (
                  <p className="list-note">Ничего не нашлось.</p>
                )}
                <ul className="dialogs">
                  {shown.map((row) => (
                    <li key={row.key}>
                      {row.kind === 'dm' ? <DmRow c={row.item} meId={user?.id} /> : <ChatRow c={row.item} meId={user?.id} />}
                    </li>
                  ))}
                </ul>

                {strangers.length > 0 && (
                  <>
                    <h2 className="list-section">Люди</h2>
                    <ul className="dialogs">
                      {strangers.map((p) => (
                        <li key={p.id}>
                          <button
                            className="dialog"
                            type="button"
                            onClick={() => {
                              setQuery('');
                              navigate(`/messages/${p.username}`);
                            }}
                          >
                            <Monogram username={p.username} displayName={p.displayName} avatarUrl={p.avatarUrl} />
                            <span className="dialog-body">
                              <span className="dialog-head">
                                <span className="dialog-name">{p.displayName}</span>
                              </span>
                              <span className="dialog-foot">
                                <span className="dialog-last">@{p.username}</span>
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        </section>

        <section className="messenger-pane" aria-label="Переписка">
          <Outlet context={{ refreshList } satisfies MessengerContext} />
        </section>
      </div>

      {creating && <NewChatDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/* ─ Строки списка ──────────────────────────────────────────────────────── */

function DmRow({ c, meId }: { c: Conversation; meId?: number }) {
  const mine = c.lastMessage.fromId === meId;
  const online = !c.blocked && isOnline(c.user.lastSeenAt);

  return (
    <NavLink className="dialog" to={`/messages/${c.user.username}`}>
      <PresenceAvatar person={c.user} />
      <span className="dialog-body">
        <span className="dialog-head">
          <span className="dialog-name">
            {c.user.displayName}
            {online && <span className="sr-only">, в сети</span>}
          </span>
          {/* Кто кого заблокировал — не сообщаем: пометка одинакова для обеих сторон. */}
          {c.blocked && <span className="dialog-flag">блокировка</span>}
          <span className="dialog-time">
            {mine && <Ticks status={c.lastMessage.readAt ? 'read' : 'sent'} />}
            <time dateTime={c.lastMessage.createdAt}>{listTime(c.lastMessage.createdAt)}</time>
          </span>
        </span>
        <span className="dialog-foot">
          <span className={c.unread > 0 ? 'dialog-last unread' : 'dialog-last'}>
            {mine && <span className="dialog-you">Вы: </span>}
            {c.lastMessage.body}
          </span>
          {c.unread > 0 && (
            <span className="badge">
              {c.unread}
              <span className="sr-only"> непрочитанных</span>
            </span>
          )}
        </span>
      </span>
    </NavLink>
  );
}

function ChatRow({ c, meId }: { c: ChatSummary; meId?: number }) {
  const last = c.lastMessage;
  const mine = last?.author.id === meId;
  const at = last?.createdAt ?? c.createdAt;

  return (
    <NavLink className="dialog" to={`/messages/c/${c.id}`}>
      {/* У общей переписки нет лица, но есть имя — по нему список читается так же быстро. */}
      <Monogram username={c.title} displayName={c.title} />
      <span className="dialog-body">
        <span className="dialog-head">
          <span className="dialog-name">{c.title}</span>
          <span className="dialog-time">
            {last && mine && <Ticks status={c.readUpTo >= last.id ? 'read' : 'sent'} />}
            <time dateTime={at}>{listTime(at)}</time>
          </span>
        </span>
        <span className="dialog-foot">
          <span className={c.unread > 0 ? 'dialog-last unread' : 'dialog-last'}>
            {last ? (
              <>
                <span className="dialog-you">{mine ? 'Вы: ' : `${last.author.displayName}: `}</span>
                {last.body}
              </>
            ) : (
              `${c.memberCount} ${plural(c.memberCount, 'участник', 'участника', 'участников')}, сообщений пока нет`
            )}
          </span>
          {c.unread > 0 && (
            <span className="badge">
              {c.unread}
              <span className="sr-only"> непрочитанных</span>
            </span>
          )}
        </span>
      </span>
    </NavLink>
  );
}

/** Правая панель, когда чат не выбран. На телефоне не видна вовсе — там
 *  вместо неё весь экран занимает список. */
export function MessengerEmpty() {
  return (
    <div className="pane-empty">
      <Icon name="message" size={40} />
      <p>Выберите чат слева или найдите человека через поиск.</p>
    </div>
  );
}
