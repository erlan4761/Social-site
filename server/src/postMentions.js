import { db } from './db.js';
import { mentionedNames } from './mentions.js';
import { notify } from './notifications.js';
import { canSeeAuthor } from './privacy.js';

/**
 * Упоминания в ленте: `@логин` в записи или комментарии — событие «упомянул
 * вас» тому, кого назвали. Разбор тот же, что у групп (mentions.js): адрес
 * почты a@b.ru упоминанием не считается.
 *
 * Правила:
 * - при правке событие получают только те, кого упомянули впервые, — правка
 *   опечатки не должна будить человека второй раз;
 * - `skip` — кому уже ушло событие об этом же комментарии («ответил вам»,
 *   «ответил на ваш комментарий»): второе было бы шумом;
 * - не больше десяти событий с одного текста — упоминание не рассылка;
 * - себя и тех, с кем автор в блокировке, notify() пропускает сам.
 */
export const MENTION_NOTIFY_MAX = 10;

export function notifyPostMentions({ authorId, postId, commentId = null, body, previousBody = null, skip = [] }) {
  const before = previousBody == null ? new Set() : mentionedNames(previousBody);
  const names = [...mentionedNames(body)].filter((n) => !before.has(n)).slice(0, MENTION_NOTIFY_MAX);
  if (names.length === 0) return 0;
  const users = db.prepare(`SELECT id FROM users WHERE username IN (${names.map(() => '?').join(', ')})`).all(...names);
  // Упоминание в закрытой записи будит только тех, кто её увидит: иначе
  // событие вело бы на «не найдено».
  const postAuthor = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(postId)?.author_id ?? authorId;
  let sent = 0;
  for (const u of users) {
    if (skip.includes(u.id)) continue;
    if (!canSeeAuthor(u.id, postAuthor)) continue;
    if (notify({ userId: u.id, actorId: authorId, kind: 'post_mention', postId, commentId })) sent += 1;
  }
  return sent;
}
