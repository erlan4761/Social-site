import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type Author, type Message } from '../api';
import { Monogram } from '../components/Monogram';
import { useSession } from '../session';
import { fullDate, timeAgo } from '../time';

const LIMIT = 1000;
/** Чаще, чем общий счётчик: открытый диалог — это ожидание ответа. */
const POLL_MS = 5_000;

export function Thread() {
  const { username = '' } = useParams();
  const { user, setUnreadTotal, refreshBadges } = useSession();

  const [other, setOther] = useState<Author | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Блокировка в любую сторону: история остаётся, форма ответа — нет.
  const [blocked, setBlocked] = useState(false);

  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const markRead = useCallback(() => {
    api
      .markRead(username)
      .then((res) => {
        setUnreadTotal(res.unreadTotal);
        // Прочтение диалога гасит и событие о нём — иначе «События» держали бы
        // счётчик до следующего опроса, уже ничего не значащий.
        refreshBadges();
      })
      .catch(() => undefined);
  }, [username, setUnreadTotal, refreshBadges]);

  // Первая загрузка: показать переписку и погасить непрочитанное.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    stick.current = true;

    api
      .thread(username)
      .then((res) => {
        if (cancelled) return;
        setOther(res.user);
        setMessages(res.messages);
        setCursor(res.nextCursor);
        setBlocked(Boolean(res.blocked));
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

  // Опрос: без WebSocket ответ собеседника иначе не появится сам.
  useEffect(() => {
    let cancelled = false;

    const timer = setInterval(() => {
      api
        .thread(username)
        .then((res) => {
          if (cancelled) return;
          // Собеседник мог заблокировать нас прямо сейчас — тем же опросом
          // убираем форму, вместо того чтобы ловить 403 после отправки.
          setBlocked(Boolean(res.blocked));
          setMessages((prev) => {
            const newest = prev.at(-1)?.id ?? 0;
            const fresh = res.messages.filter((m) => m.id > newest);
            if (fresh.length === 0) return prev;
            if (fresh.some((m) => m.toId === user?.id)) markRead();
            return [...prev, ...fresh];
          });
        })
        .catch(() => undefined);
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [username, user?.id, markRead]);

  // Прокрутка вниз — только если пользователь и так внизу: иначе
  // чтение старой переписки дёргало бы его к последнему сообщению.
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  async function loadOlder() {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    stick.current = false;
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

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > LIMIT || sending) return;

    setSending(true);
    setError(null);
    try {
      const res = await api.sendMessage(username, trimmed);
      stick.current = true;
      setMessages((prev) => [...prev, res.message]);
      setText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить');
    } finally {
      setSending(false);
    }
  }

  if (error && !other) return <p className="error">{error}</p>;

  const left = LIMIT - text.length;

  return (
    <div className="thread-page">
      <header className="thread-top">
        <Link className="btn ghost small" to="/messages">
          Ко всем
        </Link>
        {other && (
          <Link className="thread-who" to={`/u/${other.username}`}>
            <Monogram
              username={other.username}
              displayName={other.displayName}
              avatarUrl={other.avatarUrl}
              size="sm"
            />
            <span>
              <strong>{other.displayName}</strong>
              <span className="thread-handle">@{other.username}</span>
            </span>
          </Link>
        )}
      </header>

      <div className="chat">
        {loading ? (
          <p className="empty" style={{ marginLeft: 0 }}>Загружаю…</p>
        ) : (
          <>
            {cursor != null && (
              <div className="chat-more">
                <button className="btn ghost small" type="button" onClick={() => void loadOlder()} disabled={loadingMore}>
                  {loadingMore ? 'Загружаю…' : 'Показать более старые'}
                </button>
              </div>
            )}

            {messages.length === 0 && (
              <p className="empty" style={{ marginLeft: 0 }}>
                <strong>Здесь пока пусто.</strong>
                Напишите первое сообщение.
              </p>
            )}

            {messages.map((m) => (
              <div key={m.id} className={m.fromId === user?.id ? 'bubble mine' : 'bubble'}>
                <p>{m.body}</p>
                <time dateTime={m.createdAt} title={fullDate(m.createdAt)}>
                  {timeAgo(m.createdAt)}
                </time>
              </div>
            ))}
            <div ref={bottom} />
          </>
        )}
      </div>

      {error && other && <p className="error">{error}</p>}

      {/* Текст одинаков в обе стороны: по нему нельзя понять, кто кого
          заблокировал — ровно как и в ответе сервера. */}
      {blocked ? (
        <div className="notice danger chat-blocked">
          <p>
            <strong>Переписка недоступна.</strong> Пока действует блокировка, написать сюда нельзя.
            История переписки остаётся на месте.
          </p>
        </div>
      ) : (
        <form className="chat-form" onSubmit={send}>
          <label className="sr-only" htmlFor="chat-input">
            Сообщение
          </label>
          <textarea
            id="chat-input"
            rows={1}
            value={text}
            placeholder="Написать сообщение…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="chat-form-foot">
            {left <= 120 && <span className={left < 0 ? 'counter over' : 'counter'}>{left}</span>}
            <button className="btn" type="submit" disabled={!text.trim() || left < 0 || sending}>
              {sending ? 'Отправляю…' : 'Отправить'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
