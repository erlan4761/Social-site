import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useMatch, useNavigate } from 'react-router-dom';
import {
  api, ApiError, type Author, type Channel, type ChannelSummary, type ChatFolder, type ChatSummary, type Conversation,
} from '../api';
import { PresenceAvatar, Ticks, previewText } from '../components/Chat';
import { Icon } from '../components/Icon';
import { Monogram, SavedAvatar } from '../components/Monogram';
import { FoldersDialog } from '../components/FoldersDialog';
import { NewChannelDialog } from '../components/NewChannelDialog';
import { folderUnread, inFolder, readActiveFolder, toggleInFolder, writeActiveFolder, type FolderRow } from '../folders';
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

/** Имя «Избранного» в списке, поиске и шапке — переписки с самим собой. */
export const SAVED_TITLE = 'Избранное';

function rows(conversations: Conversation[], chats: ChatSummary[], channels: ChannelSummary[], meId?: number): Row[] {
  const dm: Row[] = conversations.map((c) => ({
    kind: 'dm',
    key: `dm-${c.user.id}`,
    at: c.lastMessage.createdAt,
    name: c.user.id === meId ? SAVED_TITLE : c.user.displayName,
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
  // Закреплённые — наверху, в том порядке, в каком их закрепляли; остальные —
  // по свежести, как всегда.
  return [...dm, ...group, ...channel].sort((a, b) => {
    const pa = a.item.pinnedAt;
    const pb = b.item.pinnedAt;
    if (pa && pb) return pa.localeCompare(pb);
    if (pa || pb) return pa ? -1 : 1;
    return b.at.localeCompare(a.at);
  });
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
  const [rowMenu, setRowMenu] = useState<{ row: Row; x: number; y: number } | null>(null);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [activeFolder, setActiveFolder] = useState<number | null>(() => readActiveFolder());
  const [foldersOpen, setFoldersOpen] = useState<{ editId: number | null } | null>(null);

  useEffect(() => {
    api.folders().then((res) => setFolders(res.folders)).catch(() => undefined);
  }, []);

  // Удалили открытую папку — назад во «Все».
  const current = activeFolder != null ? folders.find((f) => f.id === activeFolder) ?? null : null;
  function chooseFolder(id: number | null) {
    setActiveFolder(id);
    writeActiveFolder(id);
  }
  const press = useRef<number | null>(null);

  const meId = user?.id;
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
          meId,
        ),
      );
    });
  }, [meId]);

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
  const shown = useMemo(() => {
    if (!items) return items;
    if (q) return items.filter((r) => matches(r, q));
    return current ? items.filter((r) => inFolder(current, folderRow(r))) : items;
  }, [items, q, current]);

  async function toggleFolder(folder: ChatFolder, row: Row, on: boolean) {
    setRowMenu(null);
    try {
      const res = await api.updateFolder(folder.id, toggleInFolder(folder, folderRow(row), on));
      setFolders((prev) => prev.map((f) => (f.id === folder.id ? res.folder : f)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    }
  }

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

  /** Меню строки: правый клик, клавиша меню или долгое нажатие на телефоне. */
  function openRowMenu(row: Row, x: number, y: number, el: HTMLElement) {
    // С клавиатуры координаты нулевые — ставим меню у самой строки.
    if (x === 0 && y === 0) {
      const r = el.getBoundingClientRect();
      x = r.left + 24;
      y = r.bottom;
    }
    setRowMenu({ row, x, y });
  }

  async function applyPref(row: Row, change: { pinned?: boolean; muted?: boolean }) {
    setRowMenu(null);
    const target = row.kind === 'dm' ? row.item.user.username : row.kind === 'chat' ? row.item.id : row.item.handle;
    try {
      await api.setPref(row.kind, target, change);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    }
    refreshList();
  }

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
                    <button
                      className="msg-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        if (user) go(`/messages/${user.username}`);
                      }}
                    >
                      <Icon name="bookmark" size={18} />
                      {SAVED_TITLE}
                    </button>
                    <button
                      className="msg-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setFoldersOpen({ editId: null });
                      }}
                    >
                      <Icon name="folder" size={18} />
                      Папки чатов
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

          {folders.length > 0 && !q && (
            <div className="folder-tabs" role="tablist" aria-label="Папки чатов">
              <FolderTab label="Все" active={current == null} unread={0} onClick={() => chooseFolder(null)} />
              {folders.map((f) => (
                <FolderTab
                  key={f.id}
                  label={f.title}
                  active={current?.id === f.id}
                  unread={items ? folderUnread(f, items.map(folderRow)) : 0}
                  onClick={() => chooseFolder(f.id)}
                  onEdit={() => setFoldersOpen({ editId: f.id })}
                />
              ))}
              <button
                className="icon-btn folder-tabs-edit"
                type="button"
                aria-label="Настроить папки"
                title="Настроить папки"
                onClick={() => setFoldersOpen({ editId: null })}
              >
                <Icon name="edit" size={16} />
              </button>
            </div>
          )}

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
                {current && !q && shown.length === 0 && (
                  <p className="list-note">
                    <strong>В папке «{current.title}» пусто.</strong>
                    Добавьте чаты через меню чата — правый клик или долгое нажатие по строке во «Все».
                  </p>
                )}
                {q && shown.length === 0 && strangers.length === 0 && newChannels.length === 0 && (
                  <p className="list-note">Ничего не нашлось.</p>
                )}
                <ul className="dialogs">
                  {shown.map((row) => (
                    <li
                      key={row.key}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openRowMenu(row, e.clientX, e.clientY, e.currentTarget);
                      }}
                      onPointerDown={(e) => {
                        if (e.pointerType !== 'touch') return;
                        const { clientX, clientY } = e;
                        const el = e.currentTarget;
                        press.current = window.setTimeout(() => openRowMenu(row, clientX, clientY, el), 450);
                      }}
                      onPointerUp={() => press.current != null && window.clearTimeout(press.current)}
                      onPointerCancel={() => press.current != null && window.clearTimeout(press.current)}
                      onPointerMove={() => press.current != null && window.clearTimeout(press.current)}
                    >
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

      {rowMenu && (
        <RowMenu
          state={rowMenu}
          onClose={() => setRowMenu(null)}
          onPin={(pinned) => void applyPref(rowMenu.row, { pinned })}
          onMute={(muted) => void applyPref(rowMenu.row, { muted })}
          folders={folders.map((f) => ({ folder: f, inside: inFolder(f, folderRow(rowMenu.row)) }))}
          onFolder={(folder, on) => void toggleFolder(folder, rowMenu.row, on)}
        />
      )}

      {foldersOpen && items && (
        <FoldersDialog
          folders={folders}
          editId={foldersOpen.editId}
          chats={items.map((r) => ({
            ...folderRow(r),
            name: r.name,
            avatar:
              r.kind === 'dm' && r.item.user.id === user?.id ? (
                <SavedAvatar size="sm" />
              ) : r.kind === 'dm' ? (
                <Monogram username={r.item.user.username} displayName={r.item.user.displayName} avatarUrl={r.item.user.avatarUrl} size="sm" />
              ) : r.kind === 'chat' ? (
                <Monogram username={r.name} displayName={r.name} size="sm" />
              ) : (
                <ChannelAvatar title={r.name} size="sm" />
              ),
          }))}
          onChange={setFolders}
          onClose={() => setFoldersOpen(null)}
        />
      )}

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
  // «Избранное»: всё в нём своё, поэтому ни галочек, ни «Вы:», ни «в сети».
  const saved = c.user.id === meId;
  const mine = !saved && c.lastMessage.fromId === meId;
  const online = !saved && !c.blocked && isOnline(c.user.lastSeenAt);

  return (
    <NavLink className="dialog" to={`/messages/${c.user.username}`}>
      {saved ? <SavedAvatar /> : <PresenceAvatar person={c.user} />}
      <span className="dialog-body">
        <span className="dialog-head">
          <span className="dialog-name">
            {saved ? SAVED_TITLE : c.user.displayName}
            {online && <span className="sr-only">, в сети</span>}
          </span>
          {c.muted && <MutedMark />}
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
          <RowTail unread={c.unread} muted={c.muted} pinned={Boolean(c.pinnedAt)} />
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
          {c.muted && <MutedMark />}
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
                {last.poll ? `Опрос: ${last.body}` : previewText(last.body, last.attachment)}
              </>
            ) : (
              `${c.memberCount} ${plural(c.memberCount, 'участник', 'участника', 'участников')}, сообщений пока нет`
            )}
          </span>
          {c.mentions > 0 && (
            <span className="badge at" title="Вас упомянули">
              @<span className="sr-only">, вас упомянули</span>
            </span>
          )}
          <RowTail unread={c.unread} muted={c.muted} pinned={Boolean(c.pinnedAt)} />
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
          {c.muted && <MutedMark />}
          <span className="dialog-time">
            <time dateTime={at}>{listTime(at)}</time>
          </span>
        </span>
        <span className="dialog-foot">
          <span className={c.unread > 0 ? 'dialog-last unread' : 'dialog-last'}>
            {last
              ? last.poll
                ? `Опрос: ${last.body}`
                : previewText(last.body, last.attachment)
              : c.iAmOwner
                ? 'Ваш канал. Опубликуйте первую запись'
                : 'Публикаций пока нет'}
          </span>
          <RowTail unread={c.unread} muted={c.muted} pinned={Boolean(c.pinnedAt)} />
        </span>
      </span>
    </NavLink>
  );
}

/** Приглушённый чат — перечёркнутый колокольчик рядом с именем. */
function MutedMark() {
  return (
    <span className="dialog-muted" title="Уведомления выключены">
      <Icon name="bell-off" size={14} />
      <span className="sr-only">, без уведомлений</span>
    </span>
  );
}

/** Хвост строки: счётчик непрочитанного (серый у приглушённого) или булавка. */
function RowTail({ unread, muted, pinned }: { unread: number; muted: boolean; pinned: boolean }) {
  if (unread > 0) {
    return (
      <span className={muted ? 'badge muted' : 'badge'}>
        {unread}
        <span className="sr-only"> непрочитанных</span>
      </span>
    );
  }
  if (!pinned) return null;
  return (
    <span className="dialog-pin" title="Закреплён">
      <Icon name="pin" size={15} />
      <span className="sr-only">закреплён</span>
    </span>
  );
}

/** Строка списка глазами папки: вид, id, непрочитанное, приглушён ли. */
function folderRow(row: Row): FolderRow {
  return {
    kind: row.kind,
    id: row.kind === 'dm' ? row.item.user.id : row.item.id,
    unread: row.item.unread,
    muted: row.item.muted,
  };
}

/** Вкладка папки. Правый клик — сразу правка этой папки. */
function FolderTab({
  label,
  active,
  unread,
  onClick,
  onEdit,
}: {
  label: string;
  active: boolean;
  unread: number;
  onClick: () => void;
  onEdit?: () => void;
}) {
  return (
    <button
      className={active ? 'folder-tab on' : 'folder-tab'}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onContextMenu={(e) => {
        if (!onEdit) return;
        e.preventDefault();
        onEdit();
      }}
    >
      {label}
      {unread > 0 && (
        <span className="folder-badge">
          {unread}
          <span className="sr-only"> непрочитанных</span>
        </span>
      )}
    </button>
  );
}

type RowMenuProps = {
  state: { row: Row; x: number; y: number };
  onClose: () => void;
  onPin: (pinned: boolean) => void;
  onMute: (muted: boolean) => void;
  folders: { folder: ChatFolder; inside: boolean }[];
  onFolder: (folder: ChatFolder, on: boolean) => void;
};

/** Меню строки списка: закрепить и выключить уведомления. Встаёт там, где
 *  щёлкнули, и отодвигается от краёв окна, как меню сообщения. */
function RowMenu({ state, onClose, onPin, onMute, folders, onFolder }: RowMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });
  const pinned = Boolean(state.row.item.pinnedAt);
  const muted = state.row.item.muted;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(state.x, window.innerWidth - width - 8)),
      top: state.y + height > window.innerHeight - 8 ? Math.max(8, state.y - height) : state.y,
    });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [state.x, state.y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="msg-menu" ref={ref} role="menu" aria-label={`Чат «${state.row.name}»`} style={{ left: pos.left, top: pos.top }}>
      <div className="msg-menu-list">
        <button className="msg-menu-item" type="button" role="menuitem" onClick={() => onPin(!pinned)}>
          <Icon name="pin" size={18} />
          {pinned ? 'Открепить' : 'Закрепить'}
        </button>
        <button className="msg-menu-item" type="button" role="menuitem" onClick={() => onMute(!muted)}>
          <Icon name={muted ? 'bell' : 'bell-off'} size={18} />
          {muted ? 'Включить уведомления' : 'Выключить уведомления'}
        </button>
      </div>
      {folders.length > 0 && (
        <div className="msg-menu-list row-menu-folders" role="group" aria-label="Папки">
          <span className="row-menu-label">В папках</span>
          {folders.map(({ folder, inside }) => (
            <button
              key={folder.id}
              className="msg-menu-item"
              type="button"
              role="menuitemcheckbox"
              aria-checked={inside}
              onClick={() => onFolder(folder, !inside)}
            >
              <span className="row-menu-check" aria-hidden="true">
                {inside && <Icon name="check" size={16} />}
              </span>
              {folder.title}
            </button>
          ))}
        </div>
      )}
    </div>
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
