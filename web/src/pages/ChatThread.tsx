import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, SLOW_MODE_OPTIONS, type AttachmentInput, type Chat, type ChatMessage, type PinnedPreview, type SendOptions } from '../api';
import {
  Composer, ConversationSearch, MessageList, PaneNotice, useNotice, plainText, SelectionBar, messagesCount, useSelection, PaneHead, PinnedBar, PresenceAvatar, TypingDots, revealOlder, editable, mergeLatest, previewText, typingLabel,
  type BubbleItem, type ComposerMode, type MessageAction,
} from '../components/Chat';
import { ForwardDialog, forwardingOf, type Forwarding } from '../components/ForwardDialog';
import { ScheduledBar } from '../components/Scheduled';
import { PollDialog } from '../components/PollDialog';
import { Icon } from '../components/Icon';
import { MemberSearch } from '../components/MemberSearch';
import { ReadersDialog } from '../components/chat/ReadersDialog';
import { ReactionsDialog } from '../components/chat/ReactionsDialog';
import { AutoDeleteNote, AutoDeleteSelect } from '../components/chat/AutoDelete';
import { ShareLink, siteUrl } from '../components/ShareLink';
import { Monogram } from '../components/Monogram';
import { useSession } from '../session';
import { pollEvery, useLive, useLiveConnected } from '../live';
import { isOnline, plural } from '../time';
import type { MessengerContext } from './Messenger';

const TITLE_LIMIT = 60;
/** Потолок сервера: 21-й участник получает 400, и звать его незачем. */
const MAX_MEMBERS = 20;
/** Открытый чат — это ожидание ответа, тот же шаг, что в личной переписке. */
const POLL_MS = 3_000;

/** Пересоздаётся на каждый чат (`key`), как и личная переписка. */
export function ChatThread() {
  const { id = '' } = useParams();
  return <ChatView key={id} idParam={id} />;
}

function ChatView({ idParam }: { idParam: string }) {
  const chatId = Number.parseInt(idParam, 10);
  const valid = Number.isSafeInteger(chatId) && chatId > 0;

  const navigate = useNavigate();
  const { user, refreshBadges } = useSession();
  const { refreshList } = useOutletContext<MessengerContext>();

  const [chat, setChat] = useState<Chat | null>(null);
  /** Своё сообщение, для которого открыто «Кто прочитал». */
  const [readersOf, setReadersOf] = useState<number | null>(null);
  /** Непрочитанные упоминания меня — кнопка «@» ведёт к ним по очереди, от старого. */
  const [mentionQueue, setMentionQueue] = useState<number[]>([]);
  const [reactorsOf, setReactorsOf] = useState<{ id: number; emoji: string | null } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [readUpTo, setReadUpTo] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(valid);
  const [loadingMore, setLoadingMore] = useState(false);
  // Ошибка отправки или подгрузки — переписка при этом остаётся на экране.
  const [error, setError] = useState<string | null>(null);
  // Чат недоступен: удалён, вас в нём нет или номера такого не было. Сервер
  // намеренно не различает эти случаи — для экрана это одно состояние.
  const [gone, setGone] = useState<string | null>(valid ? null : 'Чат не найден');

  const [membersOpen, setMembersOpen] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');

  const [typing, setTyping] = useState<string[]>([]);
  const [mode, setMode] = useState<ComposerMode>(null);
  const [forwarding, setForwarding] = useState<Forwarding | null>(null);
  const [notice, notify] = useNotice();
  const selection = useSelection(messages.map((m) => m.id));
  const [pollOpen, setPollOpen] = useState(false);
  const [pinned, setPinned] = useState<PinnedPreview | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jump, setJump] = useState<{ id: number; seq: number } | null>(null);
  /** Номер последнего своего изменения — см. Thread.tsx. */
  const edits = useRef(0);
  /** Растёт, когда здесь что-то отложили, — полоса «Отложено» перечитывает очередь. */
  const [scheduledVersion, setScheduledVersion] = useState(0);
  // `?m=` — открыть чат сразу на сообщении: так ведёт событие об упоминании.
  const [params, setParams] = useSearchParams();
  const wanted = Number.parseInt(params.get('m') ?? '', 10);

  const markRead = useCallback(() => {
    if (!valid) return;
    api
      .markChatRead(chatId)
      .then(() => {
        refreshBadges();
        refreshList();
      })
      .catch(() => undefined);
  }, [chatId, valid, refreshBadges, refreshList]);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    api
      .chatMessages(chatId)
      .then((res) => {
        if (cancelled) return;
        setChat(res.chat);
        setMessages(res.messages);
        setMentionQueue(res.unreadMentions ?? []);
        setReadUpTo(res.readUpTo);
        setCursor(res.nextCursor);
        setTyping(res.typing.map((t) => t.displayName));
        setPinned(res.pinned);
        markRead();
      })
      .catch((err) => {
        if (!cancelled) setGone(err instanceof ApiError ? err.message : 'Не удалось открыть чат');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, valid, markRead]);

  // Опрос: новые реплики, состав, название и отметка прочтения — всё это
  // меняют другие участники.
  // Живой поток: толчок — перечитать сразу; с ним опрос — редкая страховка.
  const every = pollEvery(useLiveConnected(), POLL_MS);
  const pullRef = useRef<() => void>(() => undefined);
  const typingTimer = useRef<number | undefined>(undefined);
  useLive((e) => {
    if (e.t === 'ready' || (e.t === 'chat' && e.id === chatId)) pullRef.current();
  });

  useEffect(() => {
    if (!valid || gone) return;
    let cancelled = false;
    const pull = () => {
      const startedAt = edits.current;
      api
        .chatMessages(chatId)
        .then((res) => {
          if (cancelled) return;
          setChat(res.chat);
          setReadUpTo(res.readUpTo);
          setTyping(res.typing.map((t) => t.displayName));
          window.clearTimeout(typingTimer.current);
          if (res.typing.length > 0) typingTimer.current = window.setTimeout(() => pullRef.current(), 6_500);
          setPinned(res.pinned);
          if (edits.current !== startedAt) return;
          setMessages((prev) => {
            const newest = prev.at(-1)?.id ?? 0;
            if (res.messages.some((m) => m.id > newest && m.author.id !== user?.id)) markRead();
            return mergeLatest(prev, res.messages);
          });
        })
        .catch((err) => {
          // Пока экран был открыт, чат могли удалить или вас из него убрать.
          if (!cancelled && err instanceof ApiError && err.status === 404) setGone(err.message);
        });
    };
    pullRef.current = pull;
    const timer = setInterval(pull, every);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [chatId, valid, gone, user?.id, markRead, every]);

  async function reveal(id: number) {
    try {
      const res = await revealOlder(id, messages, cursor, async (c) => {
        const page = await api.chatMessages(chatId, c);
        return { items: page.messages, nextCursor: page.nextCursor };
      });
      setMessages(res.list);
      setCursor(res.cursor);
      if (res.found) setJump({ id, seq: Date.now() });
      else setError('Сообщение не найдено — возможно, его удалили');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось найти сообщение');
    }
  }

  useEffect(() => {
    if (loading || !Number.isSafeInteger(wanted)) return;
    setParams({}, { replace: true });
    void reveal(wanted);
    // reveal читает текущую ленту — эффект нужен ровно раз, когда она загрузилась.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, wanted]);

  async function togglePin(id: number) {
    if (pinned?.id === id) {
      await api.unpinChatMessage(chatId);
      setPinned(null);
    } else {
      setPinned((await api.pinChatMessage(chatId, id)).pinned);
    }
  }

  async function loadOlder() {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.chatMessages(chatId, cursor);
      setMessages((prev) => [...res.messages, ...prev]);
      setCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить более старые');
    } finally {
      setLoadingMore(false);
    }
  }

  function put(updated: ChatMessage) {
    edits.current += 1;
    setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  }

  /** Своё ушло — в медленном режиме следующее можно не раньше, чем через N секунд. */
  function afterPost() {
    setChat((c) =>
      c && c.slowMode > 0 && c.myRole === 'member' ? { ...c, nextPostAt: new Date(Date.now() + c.slowMode * 1000).toISOString() } : c,
    );
  }

  async function send(text: string, opts?: SendOptions) {
    setError(null);
    try {
      if (mode?.kind === 'edit') {
        put((await api.editChatMessage(chatId, mode.id, text)).message);
      } else {
        const res = await api.sendChatMessage(chatId, text, mode?.kind === 'reply' ? mode.id : null, opts);
        edits.current += 1;
        setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
        afterPost();
        refreshList();
      }
      setMode(null);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить');
      return false;
    }
  }

  async function sendAttachment(input: Omit<AttachmentInput, 'replyTo'>) {
    setError(null);
    try {
      const res = await api.sendChatAttachment(chatId, { ...input, replyTo: mode?.kind === 'reply' ? mode.id : null });
      edits.current += 1;
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      afterPost();
      setMode(null);
      refreshList();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить файл');
      return false;
    }
  }

  /** Удалить выбранные — по одному запросу на сообщение; не удалилось — остаётся. */
  async function deleteMany(ids: number[]) {
    if (!window.confirm(`Удалить ${messagesCount(ids.length)}? Исчезнет у всех участников.`)) return false;
    setError(null);
    const done: number[] = [];
    try {
      for (const id of ids) {
        await api.deleteChatMessage(chatId, id);
        done.push(id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить');
    }
    edits.current += 1;
    setMessages((prev) => prev.filter((m) => !done.includes(m.id)));
    if (mode && done.includes(mode.id)) setMode(null);
    refreshList();
    return done.length === ids.length;
  }

  async function act(action: MessageAction, item: BubbleItem) {
    const msg = messages.find((m) => m.id === item.id);
    if (!msg) return;
    setError(null);

    try {
      switch (action.type) {
        case 'reply':
          setMode({ kind: 'reply', id: msg.id, who: msg.author.displayName, body: previewText(msg.body, msg.attachment, msg.sticker) });
          break;
        case 'edit':
          setMode({ kind: 'edit', id: msg.id, body: msg.body });
          break;
        case 'copy':
          await navigator.clipboard.writeText(plainText(msg.body, 'show'));
          break;
        case 'link':
          await navigator.clipboard.writeText(siteUrl(`messages/c/${chatId}?m=${msg.id}`));
          notify('Ссылка скопирована — открыть её смогут участники чата');
          break;
        case 'forward':
          setForwarding(forwardingOf('chat', item, previewText(msg.body, msg.attachment, msg.sticker)));
          break;
        case 'pin':
          await togglePin(msg.id);
          break;
        case 'readers':
          setReadersOf(msg.id);
          break;
        case 'reactors':
          setReactorsOf({ id: msg.id, emoji: action.emoji ?? null });
          break;
        case 'react':
          put((await api.reactChatMessage(chatId, msg.id, action.emoji)).message);
          break;
        case 'vote':
          if (msg.poll) put({ ...msg, poll: (await api.votePoll(msg.poll.id, action.options)).poll });
          break;
        case 'closePoll':
          if (msg.poll) put({ ...msg, poll: (await api.closePoll(msg.poll.id)).poll });
          break;
        case 'delete': {
          const ids = action.ids ?? [msg.id];
          const what = ids.length > 1 ? `альбом — ${ids.length} ${plural(ids.length, 'снимок', 'снимка', 'снимков')}` : 'сообщение';
          const others = msg.author.id !== user?.id;
          if (!window.confirm(others ? `Удалить ${what} от ${msg.author.displayName}? Исчезнет у всех участников.` : `Удалить ${what}? Исчезнет у всех участников.`)) return;
          for (const id of ids) await api.deleteChatMessage(chatId, id);
          edits.current += 1;
          setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
          if (mode && ids.includes(mode.id)) setMode(null);
          refreshList();
          break;
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    }
  }

  function editLast() {
    const last = [...messages].reverse().find((m) => m.author.id === user?.id && !m.forwardedFrom && editable(m.createdAt));
    if (last) setMode({ kind: 'edit', id: last.id, body: last.body });
  }

  /** После выхода и удаления чат отвечает 404 — сразу возвращаемся к списку. */
  function leavePage() {
    refreshList();
    refreshBadges();
    navigate('/messages');
  }

  async function addMember(username: string) {
    setPanelBusy(true);
    setPanelError(null);
    try {
      const res = await api.addChatMember(chatId, username);
      setChat(res.chat);
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не удалось добавить человека');
    } finally {
      setPanelBusy(false);
    }
  }

  async function removeMember(username: string, displayName: string) {
    if (!window.confirm(`Удалить ${displayName} из чата? Человек потеряет доступ к переписке.`)) return;
    setPanelBusy(true);
    setPanelError(null);
    try {
      await api.removeChatMember(chatId, username);
      const res = await api.chat(chatId);
      setChat(res.chat);
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не удалось удалить участника');
    } finally {
      setPanelBusy(false);
    }
  }

  async function leaveChat() {
    if (!user) return;
    if (!window.confirm('Выйти из чата? Переписка станет недоступна, вернуться можно только по приглашению.')) return;
    setPanelBusy(true);
    setPanelError(null);
    try {
      await api.removeChatMember(chatId, user.username);
      leavePage();
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не удалось выйти из чата');
      setPanelBusy(false);
    }
  }

  async function removeChat() {
    if (!window.confirm('Удалить чат целиком? Переписка исчезнет у всех участников, вернуть её нельзя.')) return;
    setPanelBusy(true);
    setPanelError(null);
    try {
      await api.deleteChat(chatId);
      leavePage();
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не удалось удалить чат');
      setPanelBusy(false);
    }
  }

  async function toggleAdmin(username: string, admin: boolean) {
    setPanelBusy(true);
    setPanelError(null);
    try {
      setChat((await api.setChatAdmin(chatId, username, admin)).chat);
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не получилось');
    } finally {
      setPanelBusy(false);
    }
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    const name = draftTitle.trim();
    if (!name || panelBusy) return;
    setPanelBusy(true);
    setPanelError(null);
    try {
      const res = await api.renameChat(chatId, name);
      setChat(res.chat);
      setRenaming(false);
      refreshList();
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не удалось переименовать чат');
    } finally {
      setPanelBusy(false);
    }
  }

  if (gone) {
    return (
      <div className="pane">
        <PaneHead avatar={null} title="Чат недоступен" subtitle="" />
        <div className="pane-empty">
          <p>
            <strong>{gone}.</strong> Возможно, чат удалили или вас больше нет среди участников. Переписка
            остальных при этом никуда не делась.
          </p>
          <Link to="/messages">Ко всем чатам</Link>
        </div>
      </div>
    );
  }

  // Роли: владелец — всё; администратор — порядок среди обычных участников.
  const amAdmin = chat?.myRole === 'owner' || chat?.myRole === 'admin';
  const roleOfId = (id: number) => chat?.members.find((x) => x.id === id)?.role;
  const outranks = (id: number) =>
    chat?.myRole === 'owner' ? id !== user?.id : chat?.myRole === 'admin' && roleOfId(id) === 'member';
  const muted = Boolean(chat?.adminsOnly && chat.myRole === 'member');

  const items: BubbleItem[] = messages.map((m) => {
    const mine = m.author.id === user?.id;
    return {
      id: m.id,
      body: m.body,
      createdAt: m.createdAt,
      mine,
      author: m.author,
      status: mine ? (m.id <= readUpTo ? 'read' : 'sent') : undefined,
      editedAt: m.editedAt,
      forwardedFrom: m.forwardedFrom,
      replyTo: m.replyTo,
      reactions: m.reactions,
      attachment: m.attachment,
      poll: m.poll,
      sticker: m.sticker,
      albumId: m.albumId,
      expiresAt: m.expiresAt ?? null,
      // Опрос и стикер не правятся.
      canEdit: mine && !m.forwardedFrom && !m.poll && !m.sticker && editable(m.createdAt),
      // Владелец удаляет любое сообщение, администратор — сообщения участников.
      canDelete: mine || outranks(m.author.id),
    };
  });

  // «3 участника, 1 в сети» — себя в «в сети» не считаем: это и так понятно.
  const onlineCount = chat ? chat.members.filter((m) => m.id !== user?.id && isOnline(m.lastSeenAt)).length : 0;
  const subtitle = chat
    ? `${chat.memberCount} ${plural(chat.memberCount, 'участник', 'участника', 'участников')}` +
      (onlineCount > 0 ? `, ${onlineCount} в сети` : '')
    : '';

  return (
    <div className="pane">
      <PaneHead
        avatar={chat ? <Monogram username={chat.title} displayName={chat.title} size="sm" /> : null}
        title={chat?.title ?? ''}
        subtitle={
          typing.length > 0 ? (
            <>
              {typingLabel(typing)}
              <TypingDots />
            </>
          ) : (
            subtitle
          )
        }
        live={typing.length > 0}
        actions={
          chat && (
            <>
            <button
              className={searchOpen ? 'icon-btn on' : 'icon-btn'}
              type="button"
              aria-expanded={searchOpen}
              aria-label="Поиск по переписке"
              title="Поиск по переписке"
              onClick={() => setSearchOpen((v) => !v)}
            >
              <Icon name="search" />
            </button>
            <button
              className={membersOpen ? 'icon-btn on' : 'icon-btn'}
              type="button"
              aria-expanded={membersOpen}
              aria-label="Участники"
              title="Участники"
              onClick={() => {
                setPanelError(null);
                setMembersOpen((v) => !v);
              }}
            >
              <Icon name="user" />
            </button>
            </>
          )
        }
      />

      {searchOpen && (
        <ConversationSearch
          onSearch={async (q) => (await api.searchChat(chatId, q)).results}
          onPick={(id) => {
            setSearchOpen(false);
            void reveal(id);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {pinned && (
        <PinnedBar
          pinned={pinned}
          onOpen={() => void reveal(pinned.id)}
          onUnpin={amAdmin ? () => void api.unpinChatMessage(chatId).then(() => setPinned(null)).catch(() => undefined) : undefined}
        />
      )}

      {chat && membersOpen && (
        <section className="pane-panel members" aria-label="Участники чата">
          {panelError && <p className="error">{panelError}</p>}

          <ul className="members-list">
            {chat.members.map((m) => (
              <li key={m.id}>
                <Link className="members-who" to={`/u/${m.username}`}>
                  <PresenceAvatar person={m} size="sm" />
                  <span>
                    <strong>{m.displayName}</strong>
                    <span className="members-handle">@{m.username}</span>
                  </span>
                </Link>

                {m.role === 'owner' && <span className="dialog-flag">владелец</span>}
                {m.role === 'admin' && <span className="dialog-flag">админ</span>}

                {chat.myRole === 'owner' && m.role !== 'owner' && (
                  <button
                    className="act"
                    type="button"
                    disabled={panelBusy}
                    onClick={() => void toggleAdmin(m.username, m.role !== 'admin')}
                  >
                    {m.role === 'admin' ? 'Снять админа' : 'Сделать админом'}
                  </button>
                )}

                {outranks(m.id) && (
                  <button
                    className="act act-danger"
                    type="button"
                    disabled={panelBusy}
                    onClick={() => void removeMember(m.username, m.displayName)}
                  >
                    Удалить
                  </button>
                )}
              </li>
            ))}
          </ul>

          {/* Звать людей может любой участник — так решено на сервере. */}
          {chat.memberCount < MAX_MEMBERS && (
            <MemberSearch
              label="Позвать ещё"
              exclude={chat.members.map((m) => m.username)}
              disabled={panelBusy}
              onPick={(u) => void addMember(u.username)}
            />
          )}

          <InviteBlock chat={chat} canManage={amAdmin} onChange={(invite) => setChat((c) => (c ? { ...c, invite } : c))} />
          {amAdmin && <GroupRules chat={chat} onChange={setChat} />}

          {renaming ? (
            <form className="rename-form" onSubmit={rename}>
              <label className="field" htmlFor="chat-rename">
                <span>Новое название</span>
                <input
                  id="chat-rename"
                  type="text"
                  value={draftTitle}
                  maxLength={TITLE_LIMIT}
                  onChange={(e) => setDraftTitle(e.target.value)}
                />
              </label>
              <div className="members-actions">
                <button className="btn small" type="submit" disabled={panelBusy || !draftTitle.trim()}>
                  Сохранить
                </button>
                <button className="btn ghost small" type="button" disabled={panelBusy} onClick={() => setRenaming(false)}>
                  Отмена
                </button>
              </div>
            </form>
          ) : (
            <div className="members-actions">
              {amAdmin && (
                <button
                  className="act"
                  type="button"
                  disabled={panelBusy}
                  onClick={() => {
                    setDraftTitle(chat.title);
                    setRenaming(true);
                  }}
                >
                  Переименовать
                </button>
              )}
              <button className="act act-danger" type="button" disabled={panelBusy} onClick={() => void leaveChat()}>
                Выйти из чата
              </button>
              {chat.iAmOwner && (
                <button className="act act-danger" type="button" disabled={panelBusy} onClick={() => void removeChat()}>
                  Удалить чат
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <MessageList
        items={items}
        loading={loading}
        hasMore={cursor != null}
        loadingMore={loadingMore}
        onLoadOlder={() => void loadOlder()}
        onAction={(action, item) => void act(action, item)}
        selection={selection}
        // Закреплять в группе — владельцу и администраторам.
        actions={{ pin: amAdmin, readers: true, reactors: true, link: true }}
        pinnedId={pinned?.id ?? null}
        jump={jump}
        empty={
          <>
            <strong>Здесь пока пусто.</strong>
            Напишите первое сообщение — его увидят все участники.
          </>
        }
      />

      {mentionQueue.length > 0 && !selection.active && (
        <div className="jump-wrap">
          <button
            className="jump-mention"
            type="button"
            title="К непрочитанному упоминанию"
            aria-label={`К непрочитанному упоминанию, осталось ${mentionQueue.length}`}
            onClick={() => {
              const [next, ...rest] = mentionQueue;
              setMentionQueue(rest);
              void reveal(next);
            }}
          >
            @<span className="jump-count">{mentionQueue.length}</span>
          </button>
        </div>
      )}

      {error && <p className="error pane-error">{error}</p>}
      <PaneNotice text={notice} />

      {selection.active ? (
        <SelectionBar
          selection={selection}
          items={items}
          from="chat"
          who={(m) => m.author?.displayName ?? user?.displayName ?? ''}
          onForward={setForwarding}
          onDelete={deleteMany}
        />
      ) : muted ? (
        <div className="pane-blocked">
          <strong>Пишут только администраторы.</strong> Отвечать реакциями можно.
        </div>
      ) : (
        <>
      {chat && <AutoDeleteNote seconds={chat.autoDelete} />}
      {chat && chat.slowMode > 0 && chat.myRole === 'member' && (
        <SlowModeNote slowMode={chat.slowMode} nextPostAt={chat.nextPostAt} />
      )}
      <ScheduledBar kind="chat" target={chatId} version={scheduledVersion} onSent={refreshList} />
      <Composer
        key={`chat:${chatId}`}
        draft={{ kind: 'chat', target: chatId }}
        albums
        silent
        placeholder="Сообщение в чат"
        onSchedule={async (text, at) => {
          await api.schedule('chat', chatId, text, at.toISOString());
          setScheduledVersion((n) => n + 1);
        }}
        onSend={send}
        onSendAttachment={sendAttachment}
        onSendSticker={async (sticker) => {
          setError(null);
          try {
            const res = await api.sendChatSticker(chatId, sticker);
            edits.current += 1;
            setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
            afterPost();
            refreshList();
            return true;
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Не удалось отправить стикер');
            return false;
          }
        }}
        mode={mode}
        onCancelMode={() => setMode(null)}
        onEditLast={editLast}
        onTyping={() => void api.chatTyping(chatId).catch(() => undefined)}
        mentionables={chat?.members.filter((m) => m.id !== user?.id)}
        onCreatePoll={() => setPollOpen(true)}
        autoFocus
      />
        </>
      )}

      {pollOpen && chat && (
        <PollDialog
          where={`В чате «${chat.title}»`}
          onSubmit={async (poll) => {
            const res = await api.sendChatPoll(chatId, poll);
            edits.current += 1;
            setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
            afterPost();
            refreshList();
          }}
          onClose={() => setPollOpen(false)}
        />
      )}

      {readersOf != null && <ReadersDialog chatId={chatId} messageId={readersOf} onClose={() => setReadersOf(null)} />}
      {reactorsOf && (
        <ReactionsDialog chatId={chatId} messageId={reactorsOf.id} emoji={reactorsOf.emoji} onClose={() => setReactorsOf(null)} />
      )}

      {forwarding && (
        <ForwardDialog
          groups={forwarding.groups}
          preview={forwarding.preview}
          onClose={() => setForwarding(null)}
        />
      )}
    </div>
  );
}

/**
 * Ссылка-приглашение: копирует любой участник (звать людей может каждый),
 * создаёт, меняет и отключает владелец или администратор. Смена — когда ссылка ушла не туда:
 * старая сразу перестаёт работать.
 */
function InviteBlock({ chat, canManage, onChange }: { chat: Chat; canManage: boolean; onChange: (invite: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ invite: string | null }>) {
    setBusy(true);
    setError(null);
    try {
      onChange((await action()).invite);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    } finally {
      setBusy(false);
    }
  }

  if (!chat.invite && !canManage) return null;

  return (
    <div className="invite-block">
      {error && <p className="error">{error}</p>}
      {chat.invite ? (
        <ShareLink path={`join/${chat.invite}`} label="Ссылка-приглашение: по ней вступает любой, кто вошёл" />
      ) : (
        <p className="settings-note">По ссылке в группу сможет вступить любой, кому вы её отправите.</p>
      )}
      {canManage && (
        <div className="members-actions">
          <button className="act" type="button" disabled={busy} onClick={() => void run(() => api.createInvite(chat.id))}>
            {chat.invite ? 'Сменить ссылку' : 'Создать ссылку-приглашение'}
          </button>
          {chat.invite && (
            <button className="act act-danger" type="button" disabled={busy} onClick={() => void run(() => api.revokeInvite(chat.id))}>
              Отключить ссылку
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** «10 с», «5 мин», «1 ч» — ступень медленного режима словами. */
export function slowLabel(seconds: number) {
  if (seconds === 0) return 'выключен';
  if (seconds < 60) return `${seconds} с`;
  if (seconds < 3600) return `${seconds / 60} мин`;
  return `${seconds / 3600} ч`;
}

/**
 * Порядок в группе — владельцу и администраторам: медленный режим и «пишут
 * только администраторы». Сохраняется сразу, как переключатели в настройках.
 */
function GroupRules({ chat, onChange }: { chat: Chat; onChange: (c: Chat) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: { slowMode?: number; adminsOnly?: boolean; autoDelete?: number }) {
    setBusy(true);
    setError(null);
    try {
      onChange((await api.updateChat(chat.id, patch)).chat);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="group-rules">
      {error && <p className="error">{error}</p>}
      <label className="field">
        <span>Медленный режим — одно сообщение участника в</span>
        <select value={chat.slowMode} disabled={busy} onChange={(e) => void save({ slowMode: Number(e.target.value) })}>
          {SLOW_MODE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === 0 ? 'выключен' : slowLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <AutoDeleteSelect value={chat.autoDelete} disabled={busy} onChange={(s) => void save({ autoDelete: s })} />
      <label className="choice">
        <input
          type="checkbox"
          checked={chat.adminsOnly}
          disabled={busy}
          onChange={(e) => void save({ adminsOnly: e.target.checked })}
        />
        <span>
          <strong>Пишут только администраторы</strong>
          <span className="choice-hint">Остальные читают и ставят реакции — группа становится доской объявлений.</span>
        </span>
      </label>
    </div>
  );
}

/** Над полем ввода у участника: правило медленного режима и сколько ждать. */
function SlowModeNote({ slowMode, nextPostAt }: { slowMode: number; nextPostAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  const until = nextPostAt ? Date.parse(nextPostAt) : 0;
  const left = Math.ceil((until - now) / 1000);

  useEffect(() => {
    if (until <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);

  return (
    <p className="slow-note" role="status">
      Медленный режим: одно сообщение в {slowLabel(slowMode)}
      {left > 0 && <> — следующее через {left < 60 ? `${left} с` : `${Math.ceil(left / 60)} мин`}</>}
    </p>
  );
}
