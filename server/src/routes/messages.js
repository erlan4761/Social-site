import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { blockPairSql, isBlockedPair } from '../blocks.js';
import { publicUrl } from '../media.js';
import {
  ATTACH_INSERT_COLUMNS, FWD_COLUMNS, assertEditable, attachmentOf, attachmentUpload, attachmentValues,
  clearTyping, copyAttachment, decorate, dmKey, dropAttachment, emojiOf, extraFields, forwardSource, fwdJoin,
  isTyping, readAttachment, replyIdOf, setTyping,
} from '../messageExtras.js';
import { markNotificationsRead, notify } from '../notifications.js';
import * as v from '../validate.js';

export const router = Router();

const PAGE_SIZE = 30;
const MAX_LEN = 1000;

// Каждый запрос здесь ограничен парой (я, собеседник) на уровне SQL.
// Идентификатор собеседника берётся из БД по имени, а не из тела запроса,
// поэтому подставить чужой диалог нечем.
router.use(requireAuth);

const MESSAGE_SELECT = `
  SELECT m.*, ${FWD_COLUMNS}
  FROM messages m ${fwdJoin('m')}
`;

/** Ожидает строку из MESSAGE_SELECT. Цитата и реакции — в `decorate()`. */
const serialize = (row) => ({
  id: row.id,
  body: row.body,
  createdAt: row.created_at,
  fromId: row.from_id,
  toId: row.to_id,
  readAt: row.read_at,
  attachment: attachmentOf('dm', row),
  ...extraFields(row),
});

/** Одно сообщение пары целиком: с цитатой и реакциями, как в переписке. */
function full(row, me, otherId) {
  return decorate('dm', [serialize(row)], {
    viewerId: me,
    scope: PAIR_SQL,
    scopeParams: { me, other: otherId },
  })[0];
}

/** Сообщения только этой пары — в обе стороны. */
const PAIR_SQL = '((m.from_id = :me AND m.to_id = :other) OR (m.from_id = :other AND m.to_id = :me))';

/**
 * `lastSeenAt` — только вне блокировки: заблокированный не должен узнавать,
 * когда человек заходил, и заблокировавший тоже — правило симметрично, как и
 * всё остальное в блокировках.
 */
const person = (row, { blocked = false } = {}) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  avatarUrl: publicUrl('avatar', row.avatar_path),
  lastSeenAt: blocked ? null : row.last_seen_at ?? null,
});

// Один и тот же текст в обе стороны. Если заблокированному ответить «вас
// заблокировали», а блокирующему — «вы заблокировали», по формулировке можно
// будет отличить блокировку от любой другой причины отказа.
const BLOCKED_CHAT_MESSAGE = 'Переписка с этим пользователем недоступна';
const MESSAGE_NOT_FOUND = 'Сообщение не найдено';

const unreadTotal = (userId) =>
  db.prepare('SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND read_at IS NULL').get(userId).c;

function findUser(username) {
  return db.prepare('SELECT id, username, display_name, avatar_path, last_seen_at FROM users WHERE username = ?')
    .get(String(username).toLowerCase());
}

/** Собеседник по имени из пути или 404 — общее начало почти всех ручек. */
function otherOr404(req, res) {
  const other = findUser(req.params.username);
  if (!other) res.status(404).json({ error: 'Пользователь не найден' });
  return other;
}

/** Сообщение этой пары по id из пути. Чужое и несуществующее — одно и то же. */
function pairMessage(rawId, me, otherId) {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return db.prepare(`${MESSAGE_SELECT} WHERE m.id = :id AND ${PAIR_SQL}`).get({ id, me, other: otherId }) ?? null;
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
      u.id, u.username, u.display_name, u.avatar_path, u.last_seen_at,
      m.id AS msg_id, m.body, m.created_at, m.from_id, m.to_id, m.read_at, m.edited_at,
      m.attach_path, m.attach_kind, m.attach_mime, m.attach_name, m.attach_size, m.attach_duration, m.attach_wave,
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
    conversations: rows.map((row) => {
      // Превью в списке: цитата и реакции там не показываются, запросы за ними не нужны.
      const { replyToId, ...last } = serialize({ ...row, id: row.msg_id });
      return {
        user: person(row, { blocked: Boolean(row.blocked) }),
        unread: row.unread,
        blocked: Boolean(row.blocked),
        lastMessage: { ...last, replyTo: null, reactions: [] },
      };
    }),
    unreadTotal: unreadTotal(me),
  });
});

/** Переписка с одним человеком, старые сверху. */
router.get('/:username', (req, res) => {
  const other = otherOr404(req, res);
  if (!other) return;
  const me = req.user.id;

  const cursor = Number.parseInt(req.query.cursor, 10);
  const hasCursor = Number.isSafeInteger(cursor);

  // Берём последние PAGE_SIZE, потом разворачиваем — переписка читается
  // сверху вниз, а подгружается вверх, к более старому.
  const rows = db.prepare(`
    ${MESSAGE_SELECT}
    WHERE ${PAIR_SQL} AND (:cursor IS NULL OR m.id < :cursor)
    ORDER BY m.id DESC
    LIMIT :limit
  `).all({ me, other: other.id, cursor: hasCursor ? cursor : null, limit: PAGE_SIZE + 1 });

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const blocked = isBlockedPair(me, other.id);

  res.json({
    user: person(other, { blocked }),
    messages: decorate('dm', page.map(serialize).reverse(), {
      viewerId: me,
      scope: PAIR_SQL,
      scopeParams: { me, other: other.id },
    }),
    nextCursor: hasMore ? page.at(-1).id : null,
    blocked,
    // «Печатает…» — тоже только вне блокировки.
    typing: !blocked && isTyping(dmKey(me, other.id), other.id),
  });
});

/**
 * Отправка. Обычное сообщение, ответ (`replyTo` — id сообщения этой же пары),
 * пересылка (`forward: {from: 'dm'|'chat', id}` — текст и вложение берутся из
 * оригинала) и сообщение с вложением: multipart, файл в поле `file`, подпись в
 * `body` необязательна. Голосовое — тот же файл с `voice=1`, `duration` и `wave`.
 */
router.post('/:username', attachmentUpload.single('file'), async (req, res, next) => {
  let attachment = null;
  try {
    const other = otherOr404(req, res);
    if (!other) return;
    const me = req.user.id;
    if (other.id === me) return res.status(400).json({ error: 'Нельзя написать самому себе' });
    if (isBlockedPair(me, other.id)) {
      return res.status(403).json({ error: BLOCKED_CHAT_MESSAGE });
    }

    const forward = req.file ? null : forwardSource(req.body?.forward, me);
    const body = forward
      ? forward.body
      : v.str(req.body?.body ?? '', 'сообщение', { min: req.file ? 0 : 1, max: MAX_LEN });

    const replyTo = forward ? null : replyIdOf(req.body?.replyTo);
    if (replyTo != null && !pairMessage(replyTo, me, other.id)) {
      return res.status(400).json({ error: 'Сообщение, на которое вы отвечаете, не найдено' });
    }

    // Файл — последним: всё, что может отказать без него, уже проверено, и
    // на диск не попадёт вложение к сообщению, которого не будет.
    attachment = forward ? await copyAttachment(forward.attachment) : await readAttachment(req.file, req.body);

    const info = db.prepare(`
      INSERT INTO messages (from_id, to_id, body, created_at, reply_to_id, fwd_user_id, ${ATTACH_INSERT_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(me, other.id, body, nowIso(), replyTo, forward?.fwdUserId ?? null, ...attachmentValues(attachment));

    clearTyping(dmKey(me, other.id), me);

    // Одно событие на диалог: notify() убирает предыдущее непрочитанное
    // уведомление от того же собеседника, иначе лента событий стала бы
    // копией переписки.
    notify({ userId: other.id, actorId: me, kind: 'message' });

    const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(Number(info.lastInsertRowid));
    res.status(201).json({ message: full(row, me, other.id) });
  } catch (err) {
    // Файл уже на диске, а строки нет — сироту не оставляем.
    if (attachment) dropAttachment(attachment.path);
    next(err);
  }
});

/** Отмечает прочитанным всё входящее от этого собеседника. */
router.put('/:username/read', (req, res) => {
  const other = otherOr404(req, res);
  if (!other) return;

  db.prepare('UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL')
    .run(nowIso(), req.user.id, other.id);

  // Прочитанная переписка гасит и событие о ней: иначе счётчик событий висел
  // бы после того, как диалог уже открыт и прочитан.
  markNotificationsRead({ userId: req.user.id, kind: 'message', actorId: other.id });

  res.json({ ok: true, unreadTotal: unreadTotal(req.user.id) });
});

/** «Печатает…»: клиент шлёт это раз в несколько секунд, пока человек набирает. */
router.put('/:username/typing', (req, res) => {
  const other = otherOr404(req, res);
  if (!other) return;
  // При блокировке сигнал молча отбрасывается — ответ тот же, что и без неё,
  // чтобы по нему нельзя было проверить, заблокирован ли ты.
  if (other.id !== req.user.id && !isBlockedPair(req.user.id, other.id)) {
    setTyping(dmKey(req.user.id, other.id), req.user.id);
  }
  res.json({ ok: true });
});

/** Правка своего сообщения — в течение 48 часов. Пересланное не правится: это чужие слова. */
router.patch('/:username/:id', (req, res, next) => {
  try {
    const other = otherOr404(req, res);
    if (!other) return;
    const me = req.user.id;

    const msg = pairMessage(req.params.id, me, other.id);
    if (!msg) return res.status(404).json({ error: MESSAGE_NOT_FOUND });
    assertEditable(msg.from_id, msg.created_at, me);
    if (msg.fwd_user_id != null) return res.status(403).json({ error: 'Пересланное сообщение изменить нельзя' });
    if (isBlockedPair(me, other.id)) return res.status(403).json({ error: BLOCKED_CHAT_MESSAGE });

    // У сообщения с вложением подпись можно и убрать: фото остаётся сообщением.
    const body = v.str(req.body?.body ?? '', 'сообщение', { min: msg.attach_path ? 0 : 1, max: MAX_LEN });
    // Тот же текст — не правка: пометка «изменено» без изменений только путала бы.
    if (body !== msg.body) {
      db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, nowIso(), msg.id);
    }

    const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(msg.id);
    res.json({ message: full(row, me, other.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * Удаление — у обоих, как «удалить для всех» в Телеграме, и только своего.
 * Строка стирается целиком, а не помечается: удалённое не должно оставаться в
 * базе. Ответы на него остаются и показывают «сообщение удалено». Удалять своё
 * можно и при блокировке — это не разговор, а уборка за собой.
 */
router.delete('/:username/:id', (req, res) => {
  const other = otherOr404(req, res);
  if (!other) return;
  const me = req.user.id;

  const msg = pairMessage(req.params.id, me, other.id);
  if (!msg) return res.status(404).json({ error: MESSAGE_NOT_FOUND });
  if (msg.from_id !== me) return res.status(403).json({ error: 'Удалить можно только своё сообщение' });

  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  dropAttachment(msg.attach_path);
  res.json({ ok: true });
});

/** Реакция: одна на человека, новая заменяет прежнюю. */
router.put('/:username/:id/reaction', (req, res, next) => {
  try {
    const other = otherOr404(req, res);
    if (!other) return;
    const me = req.user.id;

    const msg = pairMessage(req.params.id, me, other.id);
    if (!msg) return res.status(404).json({ error: MESSAGE_NOT_FOUND });
    if (isBlockedPair(me, other.id)) return res.status(403).json({ error: BLOCKED_CHAT_MESSAGE });

    const emoji = emojiOf(req.body?.emoji);
    db.prepare(`
      INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at
    `).run(msg.id, me, emoji, nowIso());

    res.json({ message: full(msg, me, other.id) });
  } catch (err) {
    next(err);
  }
});

/** Снять свою реакцию. Снимать можно и при блокировке — как и удалять своё. */
router.delete('/:username/:id/reaction', (req, res) => {
  const other = otherOr404(req, res);
  if (!other) return;
  const me = req.user.id;

  const msg = pairMessage(req.params.id, me, other.id);
  if (!msg) return res.status(404).json({ error: MESSAGE_NOT_FOUND });

  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(msg.id, me);
  res.json({ message: full(msg, me, other.id) });
});
