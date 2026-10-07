import { db } from './db.js';

/**
 * Закрытый профиль: его записи видят сам автор и одобренные подписчики —
 * подписка на такой профиль становится заявкой (routes/users.js). Профиль при
 * этом открыт: имя, «о себе» и счётчики видны всем, как в любой соцсети.
 *
 * Фрагмент — как blockPairSql(): для запросов с именованным :viewerId.
 * У гостя :viewerId — NULL, и закрытые записи ему не видны.
 */
const COLUMN_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;

export function canSeeAuthorSql(authorColumn) {
  if (!COLUMN_RE.test(String(authorColumn))) {
    throw new Error(`canSeeAuthorSql: недопустимое имя колонки «${authorColumn}»`);
  }
  return `(
    NOT EXISTS (SELECT 1 FROM users pv WHERE pv.id = ${authorColumn} AND pv.private = 1)
    OR ${authorColumn} IS :viewerId
    OR EXISTS (SELECT 1 FROM follows fv WHERE fv.follower_id = :viewerId AND fv.followee_id = ${authorColumn})
  )`;
}

export const isPrivate = (userId) => Boolean(db.prepare('SELECT private FROM users WHERE id = ?').get(userId)?.private);

/** То же правило в коде: видит ли viewerId записи автора authorId. */
export function canSeeAuthor(viewerId, authorId) {
  if (!isPrivate(authorId) || viewerId === authorId) return true;
  if (viewerId == null) return false;
  return Boolean(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewerId, authorId));
}
