import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
// Псевдоним: `Notification` — ещё и глобальный тип браузера, перекрывать его
// внутри модуля значит подкладывать грабли следующему читателю.
import { api, ApiError, type Notification as NotificationItem } from '../api';
import { Monogram } from '../components/Monogram';
import { useSession } from '../session';
import { fullDate, timeAgo } from '../time';

/** Куда ведёт событие. Предмет разговора может быть удалён к моменту
 *  прочтения — тогда остаётся хотя бы профиль того, кто его вызвал. */
function targetOf(event: NotificationItem) {
  const profile = `/u/${event.actor.username}`;

  switch (event.kind) {
    case 'like':
    case 'comment':
    case 'comment_reply':
    case 'post_mention':
    case 'repost':
    case 'quote':
      return event.post ? `/p/${event.post.id}` : profile;
    case 'follow':
    case 'follow_accept':
      return profile;
    case 'follow_request':
      return '/requests';
    case 'message':
      return `/messages/${event.actor.username}`;
    case 'chat_message':
    case 'chat_invite':
      return event.chat ? `/messages/c/${event.chat.id}` : '/messages';
    case 'mention':
      if (!event.chat) return '/messages';
      return event.message ? `/messages/c/${event.chat.id}?m=${event.message.id}` : `/messages/c/${event.chat.id}`;
    case 'new_login':
      // Там список сеансов: чужой можно завершить.
      return '/settings';
  }
}

/** Что произошло — одной строкой, без восклицательных знаков. */
function lineOf(event: NotificationItem) {
  const who = event.actor.displayName;

  switch (event.kind) {
    case 'like':
      return `${who} отметил вашу запись`;
    case 'comment':
      return `${who} ответил вам`;
    case 'comment_reply':
      return `${who} ответил на ваш комментарий`;
    case 'post_mention':
      return event.comment ? `${who} упомянул вас в комментарии` : `${who} упомянул вас в записи`;
    case 'repost':
      return `${who} сделал репост вашей записи`;
    case 'quote':
      return `${who} процитировал вашу запись`;
    case 'follow':
      return `${who} подписался на вас`;
    case 'follow_request':
      return `${who} просит подписаться на вас`;
    case 'follow_accept':
      return `${who} принял вашу заявку на подписку`;
    case 'message':
      return `${who} написал вам`;
    case 'chat_message':
      return event.chat ? `Новое сообщение в чате «${event.chat.title}»` : 'Новое сообщение в чате';
    case 'chat_invite':
      return event.chat ? `Вас добавили в чат «${event.chat.title}»` : 'Вас добавили в чат';
    case 'mention':
      return event.chat ? `${who} упомянул(а) вас в чате «${event.chat.title}»` : `${who} упомянул(а) вас`;
    case 'new_login':
      return `Вход в аккаунт: ${event.device ?? 'новое устройство'}`;
  }
}

/** Цитата предмета: у ответа — сам ответ, у отметки — начало записи. */
function quoteOf(event: NotificationItem) {
  if (event.kind === 'comment' || event.kind === 'comment_reply') return event.comment?.excerpt ?? null;
  if (event.kind === 'post_mention') return event.comment?.excerpt ?? event.post?.excerpt ?? null;
  if (event.kind === 'like' || event.kind === 'repost' || event.kind === 'quote') return event.post?.excerpt ?? null;
  if (event.kind === 'mention') return event.message?.excerpt ?? null;
  if (event.kind === 'new_login') return 'Если это были не вы — завершите этот сеанс в настройках.';
  return null;
}

export function Notifications() {
  const { setNotifUnread, refreshBadges } = useSession();

  const [events, setEvents] = useState<NotificationItem[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Открытие страницы намеренно ничего не гасит: иначе события, до которых
  // человек не успел долистать, исчезали бы непрочитанными.
  useEffect(() => {
    let cancelled = false;
    api
      .notifications()
      .then((res) => {
        if (cancelled) return;
        setEvents(res.notifications);
        setCursor(res.nextCursor);
        setNotifUnread(res.unread);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить события');
      });
    return () => {
      cancelled = true;
    };
  }, [setNotifUnread]);

  async function loadMore() {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.notifications(cursor);
      setEvents((prev) => [...(prev ?? []), ...res.notifications]);
      setCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить ещё');
    } finally {
      setLoadingMore(false);
    }
  }

  async function readAll() {
    if (marking) return;
    setMarking(true);
    setError(null);
    try {
      const res = await api.readAllNotifications();
      const readAt = new Date().toISOString();
      setEvents((prev) => prev?.map((e) => (e.readAt ? e : { ...e, readAt })) ?? null);
      setNotifUnread(res.unread);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отметить прочитанными');
    } finally {
      setMarking(false);
    }
  }

  /** Клик по событию гасит его, но не задерживает переход по ссылке. */
  function read(event: NotificationItem) {
    if (event.readAt) return;
    setEvents((prev) =>
      prev?.map((e) => (e.id === event.id ? { ...e, readAt: new Date().toISOString() } : e)) ?? null,
    );
    api
      .readNotification(event.id)
      .then((res) => setNotifUnread(res.unread))
      .catch(() => refreshBadges()); // не прошло — вернёт правду следующий ответ
  }

  const unread = events?.filter((e) => !e.readAt).length ?? 0;

  return (
    <>
      <div className="events-top">
        <h1 className="page-title">События</h1>
        {unread > 0 && (
          <button className="btn ghost small" type="button" onClick={() => void readAll()} disabled={marking}>
            {marking ? 'Отмечаю…' : 'Отметить все прочитанными'}
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {events === null ? (
        !error && <p className="empty" style={{ marginLeft: 0 }}>Загружаю…</p>
      ) : events.length === 0 ? (
        <p className="empty" style={{ marginLeft: 0 }}>
          <strong>Пока ничего не происходило.</strong>
          Здесь появятся отметки, ответы, подписки и новые сообщения.
        </p>
      ) : (
        <ul className="events">
          {events.map((event) => {
            const quote = quoteOf(event);
            return (
              <li className={event.readAt ? 'event' : 'event unread'} key={event.id}>
                <Link className="event-link" to={targetOf(event)} onClick={() => read(event)}>
                  <Monogram
                    username={event.actor.username}
                    displayName={event.actor.displayName}
                    avatarUrl={event.actor.avatarUrl}
                    size="sm"
                  />

                  <div className="event-body">
                    <p className="event-line">{lineOf(event)}</p>
                    {quote && <p className="event-quote">{quote}</p>}
                    <time className="event-time" dateTime={event.createdAt} title={fullDate(event.createdAt)}>
                      {timeAgo(event.createdAt)}
                    </time>
                  </div>

                  {!event.readAt && (
                    <span className="event-mark">
                      <span className="sr-only">Новое</span>
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {cursor != null && (
        <div className="events-more">
          <button className="btn ghost" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Загружаю…' : 'Показать ещё'}
          </button>
        </div>
      )}
    </>
  );
}
