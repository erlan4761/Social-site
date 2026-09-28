import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api, ApiError, type AttachmentInput, type Chat, type ChatMessage } from '../api';
import {
  Composer, MessageList, PaneHead, PresenceAvatar, TypingDots, editable, mergeLatest, previewText, typingLabel,
  type BubbleItem, type ComposerMode, type MessageAction,
} from '../components/Chat';
import { ForwardDialog } from '../components/ForwardDialog';
import { Icon } from '../components/Icon';
import { MemberSearch } from '../components/MemberSearch';
import { Monogram } from '../components/Monogram';
import { useSession } from '../session';
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
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  /** Номер последнего своего изменения — см. Thread.tsx. */
  const edits = useRef(0);

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
        setReadUpTo(res.readUpTo);
        setCursor(res.nextCursor);
        setTyping(res.typing.map((t) => t.displayName));
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
  useEffect(() => {
    if (!valid || gone) return;
    let cancelled = false;
    const timer = setInterval(() => {
      const startedAt = edits.current;
      api
        .chatMessages(chatId)
        .then((res) => {
          if (cancelled) return;
          setChat(res.chat);
          setReadUpTo(res.readUpTo);
          setTyping(res.typing.map((t) => t.displayName));
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
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [chatId, valid, gone, user?.id, markRead]);

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

  async function send(text: string) {
    setError(null);
    try {
      if (mode?.kind === 'edit') {
        put((await api.editChatMessage(chatId, mode.id, text)).message);
      } else {
        const res = await api.sendChatMessage(chatId, text, mode?.kind === 'reply' ? mode.id : null);
        edits.current += 1;
        setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
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
      setMode(null);
      refreshList();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить файл');
      return false;
    }
  }

  async function act(action: MessageAction, item: BubbleItem) {
    const msg = messages.find((m) => m.id === item.id);
    if (!msg) return;
    setError(null);

    try {
      switch (action.type) {
        case 'reply':
          setMode({ kind: 'reply', id: msg.id, who: msg.author.displayName, body: previewText(msg.body, msg.attachment) });
          break;
        case 'edit':
          setMode({ kind: 'edit', id: msg.id, body: msg.body });
          break;
        case 'copy':
          await navigator.clipboard.writeText(msg.body);
          break;
        case 'forward':
          setForwarding(msg);
          break;
        case 'react':
          put((await api.reactChatMessage(chatId, msg.id, action.emoji)).message);
          break;
        case 'delete': {
          const others = msg.author.id !== user?.id;
          if (!window.confirm(others ? `Удалить сообщение ${msg.author.displayName}? Оно исчезнет у всех участников.` : 'Удалить сообщение? Оно исчезнет у всех участников.')) return;
          await api.deleteChatMessage(chatId, msg.id);
          edits.current += 1;
          setMessages((prev) => prev.filter((m) => m.id !== msg.id));
          if (mode?.id === msg.id) setMode(null);
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
      canEdit: mine && !m.forwardedFrom && editable(m.createdAt),
      // Владелец чата удаляет любое сообщение — как админ группы.
      canDelete: mine || Boolean(chat?.iAmOwner),
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
          )
        }
      />

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

                {m.id === chat.ownerId && <span className="dialog-flag">владелец</span>}

                {chat.iAmOwner && m.id !== user?.id && (
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
              {chat.iAmOwner && (
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
        empty={
          <>
            <strong>Здесь пока пусто.</strong>
            Напишите первое сообщение — его увидят все участники.
          </>
        }
      />

      {error && <p className="error pane-error">{error}</p>}

      <Composer
        placeholder="Сообщение в чат"
        onSend={send}
        onSendAttachment={sendAttachment}
        mode={mode}
        onCancelMode={() => setMode(null)}
        onEditLast={editLast}
        onTyping={() => void api.chatTyping(chatId).catch(() => undefined)}
        autoFocus
      />

      {forwarding && (
        <ForwardDialog
          source={{ from: 'chat', id: forwarding.id }}
          preview={previewText(forwarding.body, forwarding.attachment)}
          onClose={() => setForwarding(null)}
        />
      )}
    </div>
  );
}
