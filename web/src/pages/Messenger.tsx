import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useMatch, useNavigate } from 'react-router-dom';
import {
  api, ApiError, type Author, type Channel, type ChannelSummary, type ChatSummary, type Conversation,
} from '../api';
import { PresenceAvatar, Ticks, previewText } from '../components/Chat';
import { Icon } from '../components/Icon';
import { Monogram } from '../components/Monogram';
import { NewChannelDialog } from '../components/NewChannelDialog';
import { NewChatDialog } from '../components/NewChatDialog';
import { useSession } from '../session';
import { isOnline, listTime, plural } from '../time';

/** Список обновляется сам: в две колонки он всё время на виду, и новое
 *  сообщение из другого чата должно поднять его наверх без перезагрузки. */
const LIST_POLL_MS = 10_000;
/** Поиск людей и каналов — после паузы в наборе, а не на каждую букву. */
const SEARCH_DEBOUNCE_MS = 250;

/** Что получает открытая переписка от мессенджера через `<Outlet context>`. */
export type MessengerContext = { refreshList: () => void };

/** Личная переписка, групповой чат и канал живут в разных пространствах API,
 *  но в списке стоят вперемешку: разница — дело сервера, а не человека,
 *  который ищет вчерашний разговор. */
type Row =
  | { kind: 'dm'; key: string; at: string; name: string; item: Conversation }
  | { kind: 'chat'; key: string; at: string; name: string; item: ChatSummary }
  | { kind: 'channel'; key: string; at: string; name: string; item: ChannelSummary };

function rows(conversations: Conversation[], chats: ChatSummary[], channels: ChannelSummary[]): Row[] {
  const dm: Row[] = conversations.map((c) => ({
    kind: 'dm',
    key: `dm-${c.user.id}`,
    at: c.lastMessage.createdAt,
    name: c.user.displayName,
    item: c,
  }));
  // Чат и канал без сообщений встают по дате создания — иначе только что
  // созданные оказались бы в самом низу.
  const group: Row[] = chats.map((c) => ({
    kind: 'chat',
    key: `chat-${c.id}`,
    at: c.lastMessage?.createdAt ?? c.createdAt,
    name: c.title,
    item: c,
  }));
  const channel: Row[] = channels.map((c) => ({
    kind: 'channel',
    key: `channel-${c.id}`,
    at: c.lastPost?.createdAt ?? c.createdAt,
    name: c.title,
    item: c,
  }));
  return [...dm, ...group, ...channel].sort((a, b) => b.at.localeCompare(a.at));
}

const fold = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');

function matches(row: Row, q: string) {
  if (fold(row.name).includes(q)) return true;
  if (row.kind === 'dm') return fold(row.item.user.username).includes(q);
  if (row.kind === 'channel') return row.item.handle.includes(q.replace(/^@/, ''));
  return false;
}

export function Messenger() {
  const { user, refreshBadges } = useSession();
  const navigate = useNavigate();
  const open = useMatch('/messages/:first/*') != null;

  const [items, setItems] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<'chat' | 'channel' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Author[]>([]);
  const [foundChannels, setFoundChannels] = useState<Channel[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    // allSettled: три независимых списка, падение одного — не повод прятать остальные.
    return Promise.allSettled([api.conversations(), api.chats(), api.channels()]).then(([dm, chats, channels]) => {
      if (dm.status === 'rejected' && chats.status === 'rejected' && channels.status === 'rejected') {
        const err = dm.reason;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить чаты');
        return;
      }
      setError(
        dm.status === 'rejected'
          ? 'Личные переписки не загрузились.'
          : chats.status === 'rejected'
            ? 'Групповые чаты не загрузились.'
            : channels.status === 'rejected'
              ? 'Каналы не загрузились.'
              : null,
      );
      setItems(
        rows(
          dm.status === 'fulfilled' ? dm.value.conversations : [],
          chats.status === 'fulfilled' ? chats.value.chats : [],
          channels.status === 'fulfilled' ? channels.value.channels : [],
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

  // Меню «+» закрывается щелчком мимо и Esc.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const q = fold(query.trim());
  const shown = useMemo(() => (items && q ? items.filter((r) => matches(r, q)) : items), [items, q]);

  // Глобальный поиск — как в Телеграме: набрал имя, и среди результатов есть
  // люди, с кем переписки ещё не было, и каналы, на которые ещё не подписан.
  useEffect(() => {
    if (q.length < 2) {
      setPeople([]);
      setFoundChannels([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.allSettled([api.searchUsers(query.trim()), api.searchChannels(query.trim())]).then(([u, c]) => {
        if (cancelled) return;
        setPeople(u.status === 'fulfilled' ? u.value.users : []);
        setFoundChannels(c.status === 'fulfilled' ? c.value.channels : []);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, query]);

  const known = new Set(
    (items ?? []).filter((r): r is Extract<Row, { kind: 'dm' }> => r.kind === 'dm').map((r) => r.item.user.id),
  );
  const strangers = people.filter((p) => p.id !== user?.id && !known.has(p.id));
  const newChannels = foundChannels.filter((c) => !c.subscribed);

  function go(path: string) {
    setQuery('');
    navigate(path);
  }

  return (
    <div className="messenger">
      <div className={open ? 'messenger-grid has-open' : 'messenger-grid'}>
        <section className="messenger-list" aria-label="Чаты">
          <div className="list-head">
            <h1 className="list-title">Сообщения</h1>
            <div className="list-new" ref={menuRef}>
              <button
                className={menuOpen ? 'icon-btn on' : 'icon-btn'}
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Создать"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Создать группу или канал"
              >
                <Icon name="plus" />
              </button>
              {menuOpen && (
                <div className="msg-menu list-new-menu" role="menu">
                  <div className="msg-menu-list">
                    <button
                      className="msg-menu-item"
                      type="button"
                      role="menuitem"
                      autoFocus
                      onClick={() => {
                        setMenuOpen(false);
                        setCreating('chat');
                      }}
                    >
                      <Icon name="user" size={18} />
                      Новая группа
                    </button>
                    <button
                      className="msg-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setCreating('channel');
                      }}
                    >
                      <Icon name="megaphone" size={18} />
                      Новый канал
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <label className="list-search">
            <Icon name="search" size={18} />
            <span className="sr-only">Поиск по чатам, людям и каналам</span>
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
                Найдите человека или канал через поиск выше — или создайте группу.
              </p>
            ) : (
              <>
                {q && shown.length === 0 && strangers.length === 0 && newChannels.length === 0 && (
                  <p className="list-note">Ничего не нашлось.</p>
                )}
                <ul className="dialogs">
                  {shown.map((row) => (
                    <li key={row.key}>
                      {row.kind === 'dm' ? (
                        <DmRow c={row.item} meId={user?.id} />
                      ) : row.kind === 'chat' ? (
                        <ChatRow c={row.item} meId={user?.id} />
                      ) : (
                        <ChannelRow c={row.item} />
                      )}
                    </li>
                  ))}
                </ul>

                {newChannels.length > 0 && (
                  <>
                    <h2 className="list-section">Каналы</h2>
                    <ul className="dialogs">
                      {newChannels.map((c) => (
                        <li key={c.id}>
                          <button className="dialog" type="button" onClick={() => go(`/messages/ch/${c.handle}`)}>
                            <ChannelAvatar title={c.title} />
                            <span className="dialog-body">
                              <span className="dialog-head">
                                <span className="dialog-name">{c.title}</span>
                              </span>
                              <span className="dialog-foot">
                                <span className="dialog-last">
                                  @{c.handle}, {c.subscriberCount}{' '}
                                  {plural(c.subscriberCount, 'подписчик', 'подписчика', 'подписчиков')}
                                </span>
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {strangers.length > 0 && (
                  <>
                    <h2 className="list-section">Люди</h2>
                    <ul className="dialogs">
                      {strangers.map((p) => (
                        <li key={p.id}>
                          <button className="dialog" type="button" onClick={() => go(`/messages/${p.username}`)}>
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

      {creating === 'chat' && <NewChatDialog onClose={() => setCreating(null)} />}
      {creating === 'channel' && (
        <NewChannelDialog
          onClose={() => setCreating(null)}
          onCreated={(c) => {
            setCreating(null);
            refreshList();
            navigate(`/messages/ch/${c.handle}`);
          }}
        />
      )}
    </div>
  );
}

/* ─ Строки списка ──────────────────────────────────────────────────────── */

/** Аватар канала — монограмма по названию и значок рупора в углу: канал в
 *  списке сразу отличим от человека и от группы. */
export function ChannelAvatar({ title, size = 'md' }: { title: string; size?: 'sm' | 'md' }) {
  return (
    <span className={size === 'sm' ? 'channel-avatar sm' : 'channel-avatar'}>
      <Monogram username={title} displayName={title} size={size === 'sm' ? 'sm' : undefined} />
      <span className="channel-mark" aria-hidden="true">
        <Icon name="megaphone" size={size === 'sm' ? 10 : 12} />
      </span>
    </span>
  );
}

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
            {previewText(c.lastMessage.body, c.lastMessage.attachment)}
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
                {previewText(last.body, last.attachment)}
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

function ChannelRow({ c }: { c: ChannelSummary }) {
  const last = c.lastPost;
  const at = last?.createdAt ?? c.createdAt;

  return (
    <NavLink className="dialog" to={`/messages/ch/${c.handle}`}>
      <ChannelAvatar title={c.title} />
      <span className="dialog-body">
        <span className="dialog-head">
          <span className="dialog-name">
            {c.title}
            <span className="sr-only">, канал</span>
          </span>
          <span className="dialog-time">
            <time dateTime={at}>{listTime(at)}</time>
          </span>
        </span>
        <span className="dialog-foot">
          <span className={c.unread > 0 ? 'dialog-last unread' : 'dialog-last'}>
            {last
              ? previewText(last.body, last.attachment)
              : c.iAmOwner
                ? 'Ваш канал. Опубликуйте первую запись'
                : 'Публикаций пока нет'}
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
      <p>Выберите чат слева или найдите человека или канал через поиск.</p>
    </div>
  );
}
