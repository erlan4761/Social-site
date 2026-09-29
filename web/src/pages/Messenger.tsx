import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useMatch, useNavigate } from 'react-router-dom';
import { api, ApiError, type Author, type Channel, type ChatFolder } from '../api';
import { Icon } from '../components/Icon';
import { Monogram, SavedAvatar } from '../components/Monogram';
import { FoldersDialog } from '../components/FoldersDialog';
import { NewChannelDialog } from '../components/NewChannelDialog';
import { NewChatDialog } from '../components/NewChatDialog';
import { ChannelAvatar, ChatRow, ChannelRow, DmRow } from '../components/messenger/ListRows';
import { FolderTab } from '../components/messenger/FolderTab';
import { RowMenu } from '../components/messenger/RowMenu';
import { fold, folderRow, matches, rows, SAVED_TITLE } from '../components/messenger/rows';
import { folderUnread, inFolder, readActiveFolder, toggleInFolder, writeActiveFolder } from '../folders';
import { useSession } from '../session';
import { pollEvery, useLive, useLiveConnected } from '../live';
import { plural } from '../time';
import { looksLikePhone } from '../phone';
import type { Row } from '../components/messenger/rows';

/** Список обновляется сам: в две колонки он всё время на виду, и новое
 *  сообщение из другого чата должно поднять его наверх без перезагрузки. */
const LIST_POLL_MS = 10_000;
/** Поиск людей и каналов — после паузы в наборе, а не на каждую букву. */
const SEARCH_DEBOUNCE_MS = 250;

/** Что получает открытая переписка от мессенджера через `<Outlet context>`. */
export type MessengerContext = { refreshList: () => void };


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

  // Любой толчок может поменять список: новое сообщение, прочтение в другой
  // вкладке, настройки. Толчки идут пачками — перечитываем раз на пачку.
  const every = pollEvery(useLiveConnected(), LIST_POLL_MS, 60_000);
  const soon = useRef<number | undefined>(undefined);
  useLive(() => {
    window.clearTimeout(soon.current);
    soon.current = window.setTimeout(() => void load(), 250);
  });

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), every);
    return () => clearInterval(timer);
  }, [load, every]);

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
      // Набран номер с «+» — ищем и по нему: написать человеку, зная только телефон.
      const byPhone = looksLikePhone(query) ? api.findByPhone([query.trim()]) : Promise.resolve({ users: [] });
      void Promise.allSettled([api.searchUsers(query.trim()), api.searchChannels(query.trim()), byPhone]).then(([u, c, ph]) => {
        if (cancelled) return;
        const phoneHits = ph.status === 'fulfilled' ? ph.value.users : [];
        const named = u.status === 'fulfilled' ? u.value.users : [];
        setPeople([...phoneHits, ...named.filter((x) => !phoneHits.some((h) => h.id === x.id))]);
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
