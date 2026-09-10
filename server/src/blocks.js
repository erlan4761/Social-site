import { db } from './db.js';

/**
 * Блокировка в проекте симметрична: если хотя бы одна сторона заблокировала
 * другую, они не видят контент друг друга и не могут писать друг другу.
 * Одно правило вместо десяти частных — его можно проверить целиком и описать
 * в README одной фразой; поэтому и проверка живёт в одном месте, а не
 * переписывается заново в каждом роутере.
 */
export function isBlockedPair(aId, bId) {
  if (!Number.isSafeInteger(aId) || !Number.isSafeInteger(bId)) return false;
  if (aId === bId) return false;

  const row = db.prepare(`
    SELECT 1 FROM blocks
    WHERE (blocker_id = :a AND blocked_id = :b)
       OR (blocker_id = :b AND blocked_id = :a)
    LIMIT 1
  `).get({ a: aId, b: bId });

  return Boolean(row);
}

// Колонка подставляется в SQL текстом, а не параметром — параметром имя
// колонки задать нельзя. Значит, единственная защита от инъекции здесь —
// не пропускать ничего, что не выглядит как «алиас.колонка».
const COLUMN_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;

/**
 * Возвращает SQL-фрагмент, который оставляет только строки, чей автор не
 * состоит в блокировке со смотрящим. Ожидает именованный параметр `:viewerId`
 * в том же запросе.
 *
 * Когда `:viewerId` = NULL (аноним), обе половины условия дают NULL, подзапрос
 * не находит ничего и NOT EXISTS остаётся истинным — гость видит всё, как и
 * раньше. Это важно: фрагмент подставляется в те же запросы, которые
 * обслуживают неавторизованных.
 *
 * @param {string} authorColumn например `p.author_id`, `c.author_id`, `m.author_id`
 * @returns {string}
 */
export function blockPairSql(authorColumn) {
  if (!COLUMN_RE.test(String(authorColumn))) {
    throw new Error(`blockPairSql: недопустимое имя колонки «${authorColumn}»`);
  }

  return `NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE (b.blocker_id = :viewerId AND b.blocked_id = ${authorColumn})
       OR (b.blocker_id = ${authorColumn} AND b.blocked_id = :viewerId)
  )`;
}

// Готовый фрагмент для самого частого случая — ленты постов, где автор
// приходит из `posts p`. Остальные места строят свой через blockPairSql().
export const BLOCK_PAIR_SQL = blockPairSql('p.author_id');
