import { db } from './db.js';
import { isBlockedPair } from './blocks.js';

/**
 * «В сети» и «был(а) 5 минут назад» — глазами смотрящего. Правило взаимное,
 * как в Телеграме: кто прячет своё время от человека, не видит и его время.
 * Иначе «никому» было бы способом подглядывать, не показываясь.
 *
 * Спрятанное время заменяется грубой отметкой `seenRecently` — «был(а)
 * недавно», если заходил за последние три дня: собеседник понимает, что
 * человек жив, но не когда именно он был. При блокировке нет и её.
 */
export const LAST_SEEN_OPTIONS = ['all', 'follows', 'nobody'];

const RECENT_MS = 3 * 864e5;

const privacyOf = (id) =>
  db.prepare('SELECT last_seen_privacy AS p FROM users WHERE id = ?').get(id)?.p ?? 'all';

const follows = (from, to) =>
  Boolean(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(from, to));

/** Показывает ли `ownerId` своё время человеку `otherId`. */
function shares(ownerId, privacy, otherId) {
  if (privacy === 'nobody') return false;
  if (privacy === 'follows') return follows(ownerId, otherId);
  return true;
}

/**
 * `row` — строка users с `id`, `last_seen_at` и, если выбрана,
 * `last_seen_privacy`. `blocked` можно передать, если он уже посчитан.
 */
export function presenceFor(viewerId, row, { blocked } = {}) {
  const seen = row.last_seen_at ?? null;
  if (row.id === viewerId) return { lastSeenAt: seen, seenRecently: false };
  if (blocked ?? isBlockedPair(viewerId, row.id)) return { lastSeenAt: null, seenRecently: false };

  const theirs = row.last_seen_privacy ?? privacyOf(row.id);
  if (shares(row.id, theirs, viewerId) && shares(viewerId, privacyOf(viewerId), row.id)) {
    return { lastSeenAt: seen, seenRecently: false };
  }
  return { lastSeenAt: null, seenRecently: seen != null && Date.now() - Date.parse(seen) < RECENT_MS };
}
