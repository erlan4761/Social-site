import { db } from './db.js';
import { isBlockedPair } from './blocks.js';
import { notify } from './notifications.js';

/**
 * Упоминания в групповых чатах: `@логин` в тексте. Упомянутый участник
 * получает событие, даже если чат у него приглушён, — ради этого упоминают, —
 * а в списке чатов у такого чата значок «@», пока сообщение не прочитано.
 *
 * Упоминание — это строка в chat_mentions, а не поиск по тексту на лету: иначе
 * счётчик «@» в списке пришлось бы собирать разбором каждого непрочитанного
 * сообщения, и «@anna» совпадало бы с «@annabel».
 */

// Перед «@» — начало строки или не буква/цифра: адрес «a@b.ru» — не упоминание.
const MENTION_RE = /(^|[^\p{L}\p{N}_@])@([a-z0-9_]{3,20})(?![a-z0-9_])/giu;

export function mentionedNames(body) {
  const names = new Set();
  for (const match of String(body ?? '').matchAll(MENTION_RE)) names.add(match[2].toLowerCase());
  return names;
}

/**
 * Записывает упоминания сообщения заново — после отправки и после правки.
 * Событие получают только те, кто упомянут впервые: правка опечатки не должна
 * будить человека второй раз. Кого из текста убрали, у того непрочитанное
 * событие гаснет — упоминания больше нет.
 */
export function saveMentions({ chatId, messageId, authorId, body }) {
  const names = [...mentionedNames(body)];
  const targets = names.length === 0 ? [] : db.prepare(`
    SELECT u.id FROM users u JOIN chat_members cm ON cm.user_id = u.id AND cm.chat_id = ?
    WHERE u.username IN (${names.map(() => '?').join(', ')}) AND u.id <> ?
  `).all(chatId, ...names, authorId)
    .map((r) => r.id)
    // Заблокированному упоминание не приходит — как и всё остальное от этого человека.
    .filter((id) => !isBlockedPair(authorId, id));

  const before = new Set(
    db.prepare('SELECT user_id FROM chat_mentions WHERE message_id = ?').all(messageId).map((r) => r.user_id),
  );

  db.prepare('DELETE FROM chat_mentions WHERE message_id = ?').run(messageId);
  const insert = db.prepare('INSERT INTO chat_mentions (message_id, user_id) VALUES (?, ?)');
  for (const id of targets) insert.run(messageId, id);

  for (const id of targets) {
    if (!before.has(id)) notify({ userId: id, actorId: authorId, kind: 'mention', chatId, messageId });
  }
  const now = new Set(targets);
  for (const id of before) {
    if (!now.has(id)) {
      db.prepare("DELETE FROM notifications WHERE user_id = ? AND kind = 'mention' AND message_id = ? AND read_at IS NULL")
        .run(id, messageId);
    }
  }
}

/** Непрочитанные упоминания смотрящего в чате — для значка «@» в списке. */
export function unreadMentions(chatId, viewerId, lastReadId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM chat_mentions x JOIN chat_messages m ON m.id = x.message_id
    WHERE m.chat_id = ? AND x.user_id = ? AND m.id > ?
  `).get(chatId, viewerId, lastReadId).c;
}
