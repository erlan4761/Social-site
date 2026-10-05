import { db, nowIso } from './db.js';
import { isBlockedPair } from './blocks.js';
import { publicUrl } from './media.js';
import { isMuted } from './prefs.js';
import { touchBadges } from './live.js';
import { pushNotification } from './push.js';
import { deviceLabel } from './device.js';

export const NOTIFICATION_KINDS = ['like', 'comment', 'comment_reply', 'post_mention', 'repost', 'quote', 'follow', 'message', 'chat_message', 'chat_invite', 'mention', 'new_login'];

// Лайк и подписка — переключатели: их можно снять и поставить заново сколько
// угодно раз. Если каждое включение порождало бы событие, это был бы готовый
// способ дёргать человека бесконечно, поэтому на пару (получатель, актор,
// объект) приходится максимум одно уведомление.
const IDEMPOTENT_KINDS = new Set(['like', 'follow', 'repost']);

// Переписка схлопывается: на диалог (или на чат) — максимум одно непрочитанное
// уведомление. Иначе лента событий превратилась бы в дубль переписки.
const COLLAPSING_KINDS = new Set(['message', 'chat_message']);

const EXCERPT_LEN = 80;

/** Колонки, которые ожидает serializeNotification(). */
export const NOTIFICATION_SELECT = `
  SELECT n.id, n.kind, n.created_at, n.read_at, n.detail,
         a.id AS actor_id, a.username AS actor_username,
         a.display_name AS actor_display_name, a.avatar_path AS actor_avatar_path,
         p.id AS post_id, p.body AS post_body,
         c.id AS comment_id, c.body AS comment_body,
         g.id AS chat_id, g.title AS chat_title,
         cmsg.id AS message_id, cmsg.body AS message_body
  FROM notifications n
  JOIN users a ON a.id = n.actor_id
  LEFT JOIN posts    p ON p.id = n.post_id
  LEFT JOIN comments c ON c.id = n.comment_id
  LEFT JOIN chats    g ON g.id = n.chat_id
  LEFT JOIN chat_messages cmsg ON cmsg.id = n.message_id
`;

// Идентичность объекта, о котором событие: у лайка это пост, у комментария —
// пост и комментарий, у чата — чат. IS вместо = потому, что сравниваются
// колонки, которые в большинстве строк NULL.
const SAME_OBJECT = 'post_id IS :postId AND comment_id IS :commentId AND chat_id IS :chatId';

const asId = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

/**
 * Единственная точка создания уведомления. Все правила — самоуведомления,
 * блокировка, идемпотентность, схлопывание — живут здесь, а не размазаны по
 * роутам: иначе каждое новое место, которое шлёт события, пришлось бы
 * проверять заново.
 *
 * Возвращает id созданного уведомления или null, если создавать было нечего.
 */
export function notify({ userId, actorId, kind, postId = null, commentId = null, chatId = null, messageId = null, silent = false }) {
  if (!NOTIFICATION_KINDS.includes(kind)) {
    throw new Error(`notify: неизвестный вид уведомления «${kind}»`);
  }

  const user = asId(userId);
  const actor = asId(actorId);
  if (!user || !actor || user === actor) return null;

  // Заблокировать — значит перестать получать от человека что-либо.
  if (isBlockedPair(user, actor)) return null;

  // Приглушённая переписка событий не создаёт — ради этого её и приглушают.
  // Приглашение в чат — не переписка, его приглушить нельзя; упоминание
  // пробивает приглушение, как в Телеграме, — ради этого и упоминают.
  if (kind === 'message' && isMuted(user, 'dm', actor)) return null;
  if (kind === 'chat_message' && isMuted(user, 'chat', asId(chatId))) return null;

  const params = {
    userId: user,
    actorId: actor,
    kind,
    postId: asId(postId),
    commentId: asId(commentId),
    chatId: asId(chatId),
  };

  if (IDEMPOTENT_KINDS.has(kind)) {
    const existing = db.prepare(`
      SELECT id FROM notifications
      WHERE user_id = :userId AND actor_id = :actorId AND kind = :kind AND ${SAME_OBJECT}
      LIMIT 1
    `).get(params);
    if (existing) return null;
  }

  if (COLLAPSING_KINDS.has(kind)) {
    db.prepare(`
      DELETE FROM notifications
      WHERE user_id = :userId AND actor_id = :actorId AND kind = :kind
        AND chat_id IS :chatId AND read_at IS NULL
    `).run({ userId: user, actorId: actor, kind, chatId: params.chatId });
  }

  const info = db.prepare(`
    INSERT INTO notifications (user_id, actor_id, kind, post_id, comment_id, chat_id, message_id, created_at)
    VALUES (:userId, :actorId, :kind, :postId, :commentId, :chatId, :messageId, :createdAt)
  `).run({ ...params, messageId: asId(messageId), createdAt: nowIso() });

  touchBadges(user);
  // Открытой вкладки нет — пуш на устройства (решает push.js).
  pushNotification(Number(info.lastInsertRowid), { silent });
  return Number(info.lastInsertRowid);
}

/**
 * «Вход в аккаунт с нового устройства» — как у Телеграма. Событие про самого
 * человека, поэтому мимо notify() с его «себе не уведомляем»: автор события —
 * он сам. Пуш уходит на остальные устройства даже при открытой вкладке: о чужом
 * входе лучше узнать дважды, чем ни разу.
 */
export function notifyLogin(userId, userAgent) {
  const info = db.prepare(`
    INSERT INTO notifications (user_id, actor_id, kind, detail, created_at)
    VALUES (?, ?, 'new_login', ?, ?)
  `).run(userId, userId, JSON.stringify({ device: deviceLabel(userAgent) }), nowIso());
  touchBadges(userId);
  pushNotification(Number(info.lastInsertRowid), { evenIfLive: true });
}

/**
 * Отмена события: снятие лайка, отписка. Удаляется только непрочитанное —
 * то, что человек уже видел, задним числом из ленты не исчезает, иначе
 * события начали бы пропадать у него на глазах.
 *
 * Возвращает число удалённых строк.
 */
export function dropNotification({ userId, actorId, kind, postId = null, commentId = null, chatId = null }) {
  const user = asId(userId);
  const actor = asId(actorId);
  if (!user || !actor) return 0;

  const info = db.prepare(`
    DELETE FROM notifications
    WHERE user_id = :userId AND actor_id = :actorId AND kind = :kind
      AND ${SAME_OBJECT} AND read_at IS NULL
  `).run({
    userId: user,
    actorId: actor,
    kind,
    postId: asId(postId),
    commentId: asId(commentId),
    chatId: asId(chatId),
  });

  return Number(info.changes);
}

/**
 * Гасит уведомления выборочно: прочтение диалога должно гасить и событие о нём,
 * иначе счётчик событий висел бы после того, как переписка уже прочитана.
 * `kind`, `actorId` и `chatId` необязательны — без них гасится всё подряд.
 *
 * Возвращает число погашенных строк.
 */
export function markNotificationsRead({ userId, kind = null, actorId = null, chatId = null }) {
  const user = asId(userId);
  if (!user) return 0;

  const info = db.prepare(`
    UPDATE notifications SET read_at = :readAt
    WHERE user_id = :userId AND read_at IS NULL
      AND (:kind    IS NULL OR kind     = :kind)
      AND (:actorId IS NULL OR actor_id = :actorId)
      AND (:chatId  IS NULL OR chat_id  = :chatId)
  `).run({
    readAt: nowIso(),
    userId: user,
    kind: kind ?? null,
    actorId: asId(actorId),
    chatId: asId(chatId),
  });

  return Number(info.changes);
}

export const unreadCount = (userId) =>
  db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId).c;

/**
 * Подпись под событием, а не пересказ: берём первую строку текста и не даём ей
 * разрастись. Многострочный пост в ленте событий сломал бы ритм списка.
 */
function excerpt(text) {
  if (typeof text !== 'string') return '';
  const firstLine = text.split('\n', 1)[0].trim();
  if (firstLine.length > EXCERPT_LEN) return `${firstLine.slice(0, EXCERPT_LEN).trimEnd()}…`;
  return firstLine.length < text.trim().length ? `${firstLine}…` : firstLine;
}

/** Ожидает строку, выбранную через NOTIFICATION_SELECT. */
export const serializeNotification = (row) => ({
  id: row.id,
  kind: row.kind,
  createdAt: row.created_at,
  readAt: row.read_at,
  actor: {
    id: row.actor_id,
    username: row.actor_username,
    displayName: row.actor_display_name,
    avatarUrl: publicUrl('avatar', row.actor_avatar_path),
  },
  // Пост, комментарий и чат приходят через LEFT JOIN: к событию относится
  // не больше одного из них, остальные — null.
  post: row.post_id ? { id: row.post_id, excerpt: excerpt(row.post_body) } : null,
  comment: row.comment_id ? { id: row.comment_id, excerpt: excerpt(row.comment_body) } : null,
  chat: row.chat_id ? { id: row.chat_id, title: row.chat_title } : null,
  // Упоминание — с самим сообщением: цитата и переход прямо к нему.
  message: row.message_id ? { id: row.message_id, excerpt: excerpt(row.message_body) } : null,
  // Вход с нового устройства — какое устройство.
  device: row.kind === 'new_login' ? detailOf(row).device ?? null : null,
});

function detailOf(row) {
  try {
    return JSON.parse(row.detail ?? '{}') ?? {};
  } catch {
    return {};
  }
}
