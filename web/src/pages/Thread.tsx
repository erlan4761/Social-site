import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, ApiError, type Message, type Person } from '../api';
import {
  Composer, MessageList, PaneHead, PresenceAvatar, TypingDots, editable, mergeLatest, oneLine,
  type BubbleItem, type ComposerMode, type MessageAction,
} from '../components/Chat';
import { ForwardDialog } from '../components/ForwardDialog';
import { useSession } from '../session';
import { isOnline, lastSeenLabel } from '../time';
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

  /** Номер последнего своего изменения. Ответ опроса, ушедшего раньше него,
   *  не должен откатить только что поставленную реакцию или правку. */
  const edits = useRef(0);

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

  // Опрос: без WebSocket ответ сам не появится. Вместе с новыми сообщениями
  // приходят правки, реакции, удаления, галочки, «в сети» и «печатает…».
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(() => {
      const startedAt = edits.current;
      api
        .thread(username)
        .then((res) => {
          if (cancelled) return;
          setOther(res.user);
          setBlocked(Boolean(res.blocked));
          setTyping(res.typing);
          if (edits.current !== startedAt) return;
          setMessages((prev) => {
            const newest = prev.at(-1)?.id ?? 0;
            if (res.messages.some((m) => m.id > newest && m.toId === user?.id)) markRead();
            return mergeLatest(prev, res.messages);
          });
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [username, user?.id, markRead]);

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
            body: oneLine(msg.body),
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
        case 'react':
          put((await api.reactMessage(username, msg.id, action.emoji)).message);
          break;
        case 'delete':
          if (!window.confirm('Удалить сообщение? Оно исчезнет и у собеседника.')) return;
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
      status: mine ? (m.readAt ? 'read' : 'sent') : undefined,
      editedAt: m.editedAt,
      forwardedFrom: m.forwardedFrom,
      replyTo: m.replyTo,
      reactions: m.reactions,
      canEdit: mine && !m.forwardedFrom && editable(m.createdAt),
      canDelete: mine,
    };
  });

  const online = !blocked && isOnline(other?.lastSeenAt);

  return (
    <div className="pane">
      {other ? (
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
              lastSeenLabel(other.lastSeenAt)
            )
          }
          live={online || typing}
        />
      ) : (
        <header className="pane-head" />
      )}

      <MessageList
        items={items}
        loading={loading}
        hasMore={cursor != null}
        loadingMore={loadingMore}
        onLoadOlder={() => void loadOlder()}
        onAction={(action, item) => void act(action, item)}
        readOnly={blocked}
        empty={
          <>
            <strong>Здесь пока пусто.</strong>
            Напишите первое сообщение.
          </>
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
        <Composer
          placeholder="Сообщение"
          onSend={send}
          mode={mode}
          onCancelMode={() => setMode(null)}
          onEditLast={editLast}
          onTyping={() => void api.typing(username).catch(() => undefined)}
          autoFocus
        />
      )}

      {forwarding && (
        <ForwardDialog
          source={{ from: 'dm', id: forwarding.id }}
          preview={oneLine(forwarding.body)}
          onClose={() => setForwarding(null)}
        />
      )}
    </div>
  );
}
