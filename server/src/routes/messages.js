import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { blockPairSql, isBlockedPair } from '../blocks.js';
import { publicUrl } from '../media.js';
import { markNotificationsRead, notify } from '../notifications.js';
import * as v from '../validate.js';

export const router = Router();

const PAGE_SIZE = 30;
const MAX_LEN = 1000;

// Каждый запрос здесь ограничен парой (я, собеседник) на уровне SQL.
// Идентификатор собеседника берётся из БД по имени, а не из тела запроса,
// поэтому подставить чужой диалог нечем.
router.use(requireAuth);

const serialize = (row) => ({
  id: row.id,
  body: row.body,
  createdAt: row.created_at,
  fromId: row.from_id,
  toId: row.to_id,
  readAt: row.read_at,
});

const person = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  avatarUrl: publicUrl('avatar', row.avatar_path),
});

// Один и тот же текст в обе стороны. Если заблокированному ответить «вас
// заблокировали», а блокирующему — «вы заблокировали», по формулировке можно
// будет отличить блокировку от любой другой причины отказа.
const BLOCKED_CHAT_MESSAGE = 'Переписка с этим пользователем недоступна';

const unreadTotal = (userId) =>
  db.prepare('SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND read_at IS NULL').get(userId).c;

function findUser(username) {
  return db.prepare('SELECT id, username, display_name, avatar_path FROM users WHERE username = ?')
    .get(String(username).toLowerCase());
}

/** Список диалогов: собеседник, последнее сообщение, счётчик непрочитанных. */
router.get('/', (req, res) => {
  const me = req.user.id;

  const rows = db.prepare(`
    WITH mine AS (
      SELECT *, CASE WHEN from_id = :me THEN to_id ELSE from_id END AS other_id
      FROM messages
      WHERE from_id = :me OR to_id = :me
    ),
    last AS (
      SELECT other_id, MAX(id) AS last_id FROM mine GROUP BY other_id
    )
    SELECT
      u.id, u.username, u.display_name, u.avatar_path,
      m.id AS msg_id, m.body, m.created_at, m.from_id, m.to_id, m.read_at,
      (SELECT COUNT(*) FROM messages x
       WHERE x.to_id = :me AND x.from_id = u.id AND x.read_at IS NULL) AS unread,
      NOT ${blockPairSql('u.id')} AS blocked
    FROM last
    JOIN mine m ON m.id = last.last_id
    JOIN users u ON u.id = last.other_id
    ORDER BY m.id DESC
  `).all({ me, viewerId: me });

  res.json({
    // История не удаляется и диалог не исчезает из списка: блокировка — это
    // «дальше не пишем», а не «этого разговора не было». Флаг нужен клиенту,
    // чтобы показать плашку вместо формы ответа.
    conversations: rows.map((row) => ({
      user: person(row),
      unread: row.unread,
      blocked: Boolean(row.blocked),
      lastMessage: serialize({ ...row, id: row.msg_id }),
    })),
    unreadTotal: unreadTotal(me),
  });
});

/** Переписка с одним человеком, старые сверху. */
router.get('/:username', (req, res) => {
  const other = findUser(req.params.username);
  if (!other) return res.status(404).json({ error: 'Пользователь не найден' });

  const cursor = Number.parseInt(req.query.cursor, 10);
  const hasCursor = Number.isSafeInteger(cursor);

  // Берём последние PAGE_SIZE, потом разворачиваем — переписка читается
  // сверху вниз, а подгружается вверх, к более старому.
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE ((from_id = :me AND to_id = :other) OR (from_id = :other AND to_id = :me))
      AND (:cursor IS NULL OR id < :cursor)
    ORDER BY id DESC
    LIMIT :limit
  `).all({
    me: req.user.id,
    other: other.id,
    cursor: hasCursor ? cursor : null,
    limit: PAGE_SIZE + 1,
  });

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  res.json({
    user: person(other),
    messages: page.map(serialize).reverse(),
    nextCursor: hasMore ? page.at(-1).id : null,
    blocked: isBlockedPair(req.user.id, other.id),
  });
});

router.post('/:username', (req, res, next) => {
  try {
    const other = findUser(req.params.username);
    if (!other) return res.status(404).json({ error: 'Пользователь не найден' });
    if (other.id === req.user.id) return res.status(400).json({ error: 'Нельзя написать самому себе' });
    if (isBlockedPair(req.user.id, other.id)) {
      return res.status(403).json({ error: BLOCKED_CHAT_MESSAGE });
    }

    const body = v.str(req.body?.body, 'сообщение', { min: 1, max: MAX_LEN });
    const info = db.prepare('INSERT INTO messages (from_id, to_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(req.user.id, other.id, body, nowIso());

    // Одно событие на диалог: notify() убирает предыдущее непрочитанное
    // уведомление от того же собеседника, иначе лента событий стала бы
    // копией переписки.
    notify({ userId: other.id, actorId: req.user.id, kind: 'message' });

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ message: serialize(row) });
  } catch (err) {
    next(err);
  }
});

/** Отмечает прочитанным всё входящее от этого собеседника. */
router.put('/:username/read', (req, res) => {
  const other = findUser(req.params.username);
  if (!other) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare('UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL')
    .run(nowIso(), req.user.id, other.id);

  // Прочитанная переписка гасит и событие о ней: иначе счётчик событий висел
  // бы после того, как диалог уже открыт и прочитан.
  markNotificationsRead({ userId: req.user.id, kind: 'message', actorId: other.id });

  res.json({ ok: true, unreadTotal: unreadTotal(req.user.id) });
});
