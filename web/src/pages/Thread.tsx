import { useCallback, useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, ApiError, type Message, type Person } from '../api';
import { Composer, MessageList, PaneHead, PresenceAvatar, type BubbleItem } from '../components/Chat';
import { useSession } from '../session';
import { isOnline, lastSeenLabel } from '../time';
import type { MessengerContext } from './Messenger';

/** Чаще, чем список: открытая переписка — это ожидание ответа. */
const POLL_MS = 5_000;

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

  // Опрос: без WebSocket ответ сам не появится. Заодно обновляются «в сети»,
  // блокировка и галочки у своих сообщений — их меняет собеседник.
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(() => {
      api
        .thread(username)
        .then((res) => {
          if (cancelled) return;
          setOther(res.user);
          setBlocked(Boolean(res.blocked));
          const latest = new Map(res.messages.map((m) => [m.id, m]));
          setMessages((prev) => {
            const newest = prev.at(-1)?.id ?? 0;
            const fresh = res.messages.filter((m) => m.id > newest);
            // readAt своих сообщений: переписываем из свежего ответа, чтобы
            // одна галочка стала двумя, как только собеседник прочитал.
            let changed = fresh.length > 0;
            const merged = prev.map((m) => {
              const upd = latest.get(m.id);
              if (upd && upd.readAt !== m.readAt) {
                changed = true;
                return upd;
              }
              return m;
            });
            if (!changed) return prev;
            if (fresh.some((m) => m.toId === user?.id)) markRead();
            return [...merged, ...fresh];
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

  async function send(text: string) {
    setError(null);
    try {
      const res = await api.sendMessage(username, text);
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      refreshList();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить');
      return false;
    }
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
          subtitle={blocked ? `@${other.username}` : lastSeenLabel(other.lastSeenAt)}
          live={online}
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
        <Composer placeholder="Сообщение" onSend={send} autoFocus />
      )}
    </div>
  );
}
