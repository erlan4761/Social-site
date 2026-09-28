import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { blockPairSql } from '../blocks.js';
import {
  NOTIFICATION_SELECT,
  markNotificationsRead,
  serializeNotification,
  unreadCount,
} from '../notifications.js';

export const router = Router();

const PAGE_SIZE = 20;

// Лента событий — всегда своя и только своя: чужой user_id взять неоткуда,
// получатель берётся из сессии, а не из запроса.
router.use(requireAuth);

/** Numeric route param, or null when it is not a usable id. */
function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * События, новые сверху. Keyset по id, как в ленте постов: `cursor` — id
 * последнего показанного уведомления, поэтому страницы не съезжают, когда
 * сверху прилетает новое событие.
 */
router.get('/', (req, res) => {
  const cursor = intParam(req.query.cursor);

  const rows = db.prepare(`
    ${NOTIFICATION_SELECT}
    WHERE n.user_id = :me AND (:cursor IS NULL OR n.id < :cursor)
    ORDER BY n.id DESC
    LIMIT :limit
  `).all({ me: req.user.id, cursor, limit: PAGE_SIZE + 1 });

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  res.json({
    notifications: page.map(serializeNotification),
    nextCursor: hasMore ? page.at(-1).id : null,
    unread: unreadCount(req.user.id),
  });
});

// Объявлено до `/:id/read`: иначе Express принял бы «read» за id уведомления.
router.put('/read', (req, res) => {
  markNotificationsRead({ userId: req.user.id });
  res.json({ ok: true, unread: 0 });
});

router.put('/:id/read', (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(404).json({ error: 'Событие не найдено' });

  // Чужое уведомление — 404, а не 403: посторонний не должен узнавать даже
  // того, что такое событие вообще существует.
  const row = db.prepare('SELECT id, read_at FROM notifications WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Событие не найдено' });

  // Повторное погашение — не ошибка: клиент может кликнуть по уже прочитанному.
  if (!row.read_at) {
    db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(nowIso(), id);
  }

  res.json({ ok: true, unread: unreadCount(req.user.id) });
});

/**
 * Счётчики одним запросом. Раньше клиент ради одного числа тянул весь список
 * диалогов раз в 30 секунд; с тремя источниками непрочитанного это стало бы
 * тремя запросами вместо одного.
 */
export const badgesRouter = Router();

badgesRouter.use(requireAuth);

badgesRouter.get('/', (req, res) => {
  const me = req.user.id;

  const messages = db
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND read_at IS NULL')
    .get(me).c;

  // Непрочитанное в групповых чатах — по ватерлинии last_read_id. Свои
  // сообщения не считаются, а сообщения тех, с кем смотрящий в блокировке,
  // не видны в чате и не должны попадать в счётчик.
  const chats = db.prepare(`
    SELECT COUNT(*) AS c
    FROM chat_members cm
    JOIN chat_messages m ON m.chat_id = cm.chat_id AND m.id > cm.last_read_id
    WHERE cm.user_id = :viewerId
      AND m.author_id <> :viewerId
      AND ${blockPairSql('m.author_id')}
  `).get({ viewerId: me }).c;

  // Непрочитанные публикации в каналах, на которые подписан, — кроме своих
  // каналов: свои публикации владелец и так видел.
  const channels = db.prepare(`
    SELECT COUNT(*) AS c
    FROM channel_subscribers s
    JOIN channels c ON c.id = s.channel_id AND c.owner_id <> s.user_id
    JOIN channel_posts p ON p.channel_id = s.channel_id AND p.id > s.last_read_id
    WHERE s.user_id = ?
  `).get(me).c;

  res.json({ messages, chats, channels, notifications: unreadCount(me) });
});
