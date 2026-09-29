import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, ApiError, type AttachmentInput, type Message, type Person, type PinnedPreview } from '../api';
import {
  Composer, ConversationSearch, MessageList, PaneHead, PinnedBar, PresenceAvatar, TypingDots, revealOlder, editable, mergeLatest, previewText,
  type BubbleItem, type ComposerMode, type MessageAction,
} from '../components/Chat';
import { ForwardDialog } from '../components/ForwardDialog';
import { ScheduledBar } from '../components/Scheduled';
import { Icon } from '../components/Icon';
import { SavedAvatar } from '../components/Monogram';
import { useSession } from '../session';
import { pollEvery, useLive, useLiveConnected } from '../live';
import { isOnline, lastSeenLabel } from '../time';
import { SAVED_TITLE } from '../components/messenger/rows';
import type { MessengerContext } from './Messenger';

/** Открытая переписка — это ожидание ответа, и «печатает…» живёт шесть
 *  секунд: опрос чаще, чем у списка. */
const POLL_MS = 3_000;

/** Страница живёт внутри мессенджера и пересоздаётся на каждого собеседника
 *  (`key`): состояние одной переписки не должно протекать в другую. */
export function Thread() {
  const { username = '' } = useParams();
  return <ThreadView key={username.toLowerCase()} username={username} />;
}

function ThreadView({ username }: { username: string }) {
  const { user, setUnreadTotal, refreshBadges } = useSession();
  const { refreshList } = useOutletContext<MessengerContext>();

  const [other, setOther] = useState<Person | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Блокировка в любую сторону: история остаётся, поле ввода — нет.
  const [blocked, setBlocked] = useState(false);
  const [typing, setTyping] = useState(false);
  const [mode, setMode] = useState<ComposerMode>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [pinned, setPinned] = useState<PinnedPreview | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jump, setJump] = useState<{ id: number; seq: number } | null>(null);

  /** Номер последнего своего изменения. Ответ опроса, ушедшего раньше него,
   *  не должен откатить только что поставленную реакцию или правку. */
  const edits = useRef(0);
  /** Растёт, когда здесь что-то отложили, — полоса «Отложено» перечитывает очередь. */
  const [scheduledVersion, setScheduledVersion] = useState(0);
  /** «Избранное» — переписка с самим собой: заметки, ссылки, пересланное. */
  const saved = user != null && user.username === username.toLowerCase();

  const markRead = useCallback(() => {
    api
      .markRead(username)
      .then((res) => {
        setUnreadTotal(res.unreadTotal);
        // Прочтение гасит и событие о переписке, и жирную строку в списке.
        refreshBadges();
        refreshList();
      })
      .catch(() => undefined);
  }, [username, setUnreadTotal, refreshBadges, refreshList]);

  useEffect(() => {
    let cancelled = false;
    api
      .thread(username)
      .then((res) => {
        if (cancelled) return;
        setOther(res.user);
        setMessages(res.messages);
        setCursor(res.nextCursor);
        setBlocked(Boolean(res.blocked));
        setTyping(res.typing);
        setPinned(res.pinned);
        // Всегда, а не только при непрочитанных: вместе с перепиской гаснет и
        // событие о ней в «Событиях».
        markRead();
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось открыть переписку');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [username, markRead]);

  // Перечитывание переписки: вместе с новыми сообщениями приходят правки,
  // реакции, удаления, галочки, «в сети» и «печатает…». Толчок живого потока —
  // перечитать сразу; пока поток жив, опрос по таймеру — редкая страховка.
  const every = pollEvery(useLiveConnected(), POLL_MS);
  const pullRef = useRef<() => void>(() => undefined);
  const typingTimer = useRef<number | undefined>(undefined);
  useLive((e) => {
    if (e.t === 'ready' || (e.t === 'dm' && other != null && e.with === other.id)) pullRef.current();
  });

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      const startedAt = edits.current;
      api
        .thread(username)
        .then((res) => {
          if (cancelled) return;
          setOther(res.user);
          setBlocked(Boolean(res.blocked));
          setTyping(res.typing);
          window.clearTimeout(typingTimer.current);
          if (res.typing) typingTimer.current = window.setTimeout(() => pullRef.current(), 6_500);
          setPinned(res.pinned);
          if (edits.current !== startedAt) return;
          setMessages((prev) => {
            const newest = prev.at(-1)?.id ?? 0;
            if (res.messages.some((m) => m.id > newest && m.toId === user?.id)) markRead();
            return mergeLatest(prev, res.messages);
          });
        })
        .catch(() => undefined);
    };
    pullRef.current = pull;
    const timer = setInterval(pull, every);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [username, user?.id, markRead, every]);

  /** Показать сообщение: догрузить ленту до него и прокрутить. */
  async function reveal(id: number) {
    try {
      const res = await revealOlder(id, messages, cursor, async (c) => {
        const page = await api.thread(username, c);
        return { items: page.messages, nextCursor: page.nextCursor };
      });
      setMessages(res.list);
      setCursor(res.cursor);
      if (res.found) setJump({ id, seq: Date.now() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось найти сообщение');
    }
  }

  async function togglePin(id: number) {
    if (pinned?.id === id) {
      await api.unpinMessage(username);
      setPinned(null);
    } else {
      setPinned((await api.pinMessage(username, id)).pinned);
    }
  }

  async function loadOlder() {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.thread(username, cursor);
      setMessages((prev) => [...res.messages, ...prev]);
      setCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить более старые');
    } finally {
      setLoadingMore(false);
    }
  }

  /** Заменить одно сообщение ответом сервера — после правки или реакции. */
  function put(updated: Message) {
    edits.current += 1;
    setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  }

  async function send(text: string) {
    setError(null);
    try {
      if (mode?.kind === 'edit') {
        const res = await api.editMessage(username, mode.id, text);
        put(res.message);
      } else {
        const res = await api.sendMessage(username, text, mode?.kind === 'reply' ? mode.id : null);
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

  /** Файл с подписью или голосовое. Ответом может быть и вложение. */
  async function sendAttachment(input: Omit<AttachmentInput, 'replyTo'>) {
    setError(null);
    try {
      const res = await api.sendAttachment(username, { ...input, replyTo: mode?.kind === 'reply' ? mode.id : null });
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
    if (!msg || !other) return;
    setError(null);

    try {
      switch (action.type) {
        case 'reply':
          setMode({
            kind: 'reply',
            id: msg.id,
            who: msg.fromId === user?.id ? (user?.displayName ?? '') : other.displayName,
            body: previewText(msg.body, msg.attachment, msg.sticker),
          });
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
        case 'pin':
          await togglePin(msg.id);
          break;
        case 'react':
          put((await api.reactMessage(username, msg.id, action.emoji)).message);
          break;
        case 'delete':
          if (!window.confirm(saved ? 'Удалить сообщение?' : 'Удалить сообщение? Оно исчезнет и у собеседника.')) return;
          await api.deleteMessage(username, msg.id);
          edits.current += 1;
          setMessages((prev) => prev.filter((m) => m.id !== msg.id));
          if (mode?.id === msg.id) setMode(null);
          refreshList();
          break;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    }
  }

  /** Стрелка вверх в пустом поле — правка последнего своего, которое ещё можно править. */
  function editLast() {
    const last = [...messages].reverse().find((m) => m.fromId === user?.id && !m.forwardedFrom && editable(m.createdAt));
    if (last) setMode({ kind: 'edit', id: last.id, body: last.body });
  }

  if (error && !other) {
    return (
      <div className="pane">
        <div className="pane-empty">
          <p className="error">{error}</p>
        </div>
      </div>
    );
  }

  const items: BubbleItem[] = messages.map((m) => {
    const mine = m.fromId === user?.id;
    return {
      id: m.id,
      body: m.body,
      createdAt: m.createdAt,
      mine,
      status: mine && !saved ? (m.readAt ? 'read' : 'sent') : undefined,
      editedAt: m.editedAt,
      forwardedFrom: m.forwardedFrom,
      replyTo: m.replyTo,
      reactions: m.reactions,
      attachment: m.attachment,
      sticker: m.sticker,
      canEdit: mine && !m.forwardedFrom && !m.sticker && editable(m.createdAt),
      canDelete: mine,
    };
  });

  const online = !saved && !blocked && isOnline(other?.lastSeenAt);

  return (
    <div className="pane">
      {other && saved ? (
        <PaneHead
          avatar={<SavedAvatar size="sm" />}
          title={SAVED_TITLE}
          subtitle="заметки, ссылки и пересланное — только для вас"
          actions={
            <button
              className={searchOpen ? 'icon-btn on' : 'icon-btn'}
              type="button"
              aria-expanded={searchOpen}
              aria-label="Поиск по «Избранному»"
              title="Поиск по «Избранному»"
              onClick={() => setSearchOpen((v) => !v)}
            >
              <Icon name="search" />
            </button>
          }
        />
      ) : other ? (
        <PaneHead
          to={`/u/${other.username}`}
          avatar={<PresenceAvatar person={blocked ? { ...other, lastSeenAt: null } : other} size="sm" />}
          title={other.displayName}
          // При блокировке — не «был(а) давно»: это выдавало бы, что время
          // визита скрыто. Показываем логин, как у любого другого.
          subtitle={
            blocked ? (
              `@${other.username}`
            ) : typing ? (
              <>
                печатает
                <TypingDots />
              </>
            ) : (
              lastSeenLabel(other.lastSeenAt, other.seenRecently)
            )
          }
          live={online || typing}
          actions={
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
          }
        />
      ) : (
        <header className="pane-head" />
      )}

      {searchOpen && (
        <ConversationSearch
          onSearch={async (q) => (await api.searchThread(username, q)).results}
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
          onUnpin={blocked ? undefined : () => void api.unpinMessage(username).then(() => setPinned(null)).catch(() => undefined)}
        />
      )}

      <MessageList
        items={items}
        loading={loading}
        hasMore={cursor != null}
        loadingMore={loadingMore}
        onLoadOlder={() => void loadOlder()}
        onAction={(action, item) => void act(action, item)}
        actions={{ pin: !blocked }}
        pinnedId={pinned?.id ?? null}
        jump={jump}
        readOnly={blocked}
        empty={
          saved ? (
            <>
              <strong>Это ваше «Избранное».</strong>
              Пишите сюда заметки, сохраняйте ссылки и файлы, пересылайте сообщения из любых чатов — видите их
              только вы.
            </>
          ) : (
            <>
              <strong>Здесь пока пусто.</strong>
              Напишите первое сообщение.
            </>
          )
        }
      />

      {error && other && <p className="error pane-error">{error}</p>}

      {/* Текст одинаков в обе стороны: по нему нельзя понять, кто кого
          заблокировал — ровно как и в ответе сервера. */}
      {blocked ? (
        <div className="pane-blocked">
          <strong>Переписка недоступна.</strong> Пока действует блокировка, написать сюда нельзя. История
          остаётся на месте.
        </div>
      ) : (
        <>
          <ScheduledBar kind="dm" target={username} version={scheduledVersion} onSent={refreshList} />
          <Composer
            placeholder={saved ? 'Заметка для себя' : 'Сообщение'}
            onSchedule={async (text, at) => {
              await api.schedule('dm', username, text, at.toISOString());
              setScheduledVersion((n) => n + 1);
            }}
            onSend={send}
            onSendAttachment={sendAttachment}
            onSendSticker={async (sticker) => {
              setError(null);
              try {
                const res = await api.sendSticker(username, sticker);
                edits.current += 1;
                setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
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
            onTyping={saved ? undefined : () => void api.typing(username).catch(() => undefined)}
            autoFocus
          />
        </>
      )}

      {forwarding && (
        <ForwardDialog
          source={{ from: 'dm', id: forwarding.id }}
          preview={previewText(forwarding.body, forwarding.attachment, forwarding.sticker)}
          onClose={() => setForwarding(null)}
        />
      )}
    </div>
  );
}
