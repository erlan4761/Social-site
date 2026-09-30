import { db, nowIso } from './db.js';
import { touchChannel, touchChat, touchDm } from './live.js';
import { dmScope, unpinIfPinned } from './pins.js';
import { dropAttachment } from './messageExtras.js';

/**
 * Автоудаление сообщений — как в Телеграме: таймер на переписку, группу или
 * канал, и всё, что отправлено при включённом таймере, исчезает через сутки,
 * неделю или месяц. В личной переписке таймер общий и включить его может любой
 * из двоих, в группе — владелец и администраторы, в канале — владелец.
 *
 * Срок пишется в само сообщение при отправке (expires_at), а не вычисляется из
 * текущего таймера: смена таймера касается только новых сообщений — старые
 * исчезнут по тому правилу, при котором их отправили. Удаляет их тот же
 * планировщик, что отправляет отложенные (scheduled.js), — со всем, что
 * убирает обычное удаление: файлом вложения и закреплением.
 */
export const AUTO_DELETE_OPTIONS = [0, 86_400, 604_800, 2_592_000];

const pair = (a, b) => [Math.min(a, b), Math.max(a, b)];

export function dmAutoDelete(a, b) {
  const [low, high] = pair(a, b);
  return db.prepare('SELECT auto_delete FROM dm_settings WHERE low_id = ? AND high_id = ?').get(low, high)?.auto_delete ?? 0;
}

export function setDmAutoDelete(a, b, seconds) {
  const [low, high] = pair(a, b);
  if (!seconds) {
    db.prepare('DELETE FROM dm_settings WHERE low_id = ? AND high_id = ?').run(low, high);
    return;
  }
  db.prepare(`
    INSERT INTO dm_settings (low_id, high_id, auto_delete) VALUES (?, ?, ?)
    ON CONFLICT (low_id, high_id) DO UPDATE SET auto_delete = excluded.auto_delete
  `).run(low, high, seconds);
}

/** Когда исчезнет сообщение, отправленное сейчас, — или null, если таймер выключен. */
export function expiryFor(kind, targetId, fromId = null) {
  const seconds = kind === 'dm'
    ? dmAutoDelete(fromId, targetId)
    : db.prepare(`SELECT auto_delete FROM ${kind === 'chat' ? 'chats' : 'channels'} WHERE id = ?`).get(targetId)?.auto_delete ?? 0;
  return seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null;
}

/** Проверка значения таймера из запроса; undefined — «не менять». */
export function readAutoDelete(raw) {
  if (raw === undefined) return undefined;
  if (!AUTO_DELETE_OPTIONS.includes(raw)) {
    throw Object.assign(new Error(`Автоудаление — одно из: ${AUTO_DELETE_OPTIONS.join(', ')} секунд`), { status: 400 });
  }
  return raw;
}

/** Убрать всё, чей срок вышел, и толкнуть открытые вкладки участников. */
export function sweepExpired() {
  const now = nowIso();

  const dms = db.prepare('SELECT id, from_id, to_id, attach_path FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?').all(now);
  const chats = db.prepare('SELECT id, chat_id, attach_path FROM chat_messages WHERE expires_at IS NOT NULL AND expires_at <= ?').all(now);
  const posts = db.prepare('SELECT id, channel_id, attach_path FROM channel_posts WHERE expires_at IS NOT NULL AND expires_at <= ?').all(now);
  if (!dms.length && !chats.length && !posts.length) return 0;

  db.exec('BEGIN');
  try {
    const drop = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const m of dms) {
      drop.run(m.id);
      unpinIfPinned('dm', dmScope(m.from_id, m.to_id), m.id);
    }
    const dropChat = db.prepare('DELETE FROM chat_messages WHERE id = ?');
    for (const m of chats) {
      dropChat.run(m.id);
      unpinIfPinned('chat', m.chat_id, m.id);
    }
    const dropPost = db.prepare('DELETE FROM channel_posts WHERE id = ?');
    for (const p of posts) {
      dropPost.run(p.id);
      unpinIfPinned('channel', p.channel_id, p.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Файлы — после COMMIT: откат не должен оставить сообщение без его файла.
  [...dms, ...chats, ...posts].forEach((m) => dropAttachment(m.attach_path));
  new Set(dms.map((m) => dmScope(m.from_id, m.to_id))).forEach((scope) => {
    const [a, b] = scope.split('-').map(Number);
    touchDm(a, b);
  });
  new Set(chats.map((m) => m.chat_id)).forEach((id) => touchChat(id));
  new Set(posts.map((p) => p.channel_id)).forEach((id) => touchChannel(id));
  return dms.length + chats.length + posts.length;
}
