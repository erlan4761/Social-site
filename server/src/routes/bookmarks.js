import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { POST_COLUMNS, serialize, POST_VISIBLE_SQL } from './posts.js';

export const router = Router();

const PAGE_SIZE = 20;

/** Numeric query param, or null when it is not a usable id. */
function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Свои закладки, последняя сохранённая сверху.
 *
 * Курсор здесь — id **закладки**, а не записи, и это не деталь реализации, а
 * суть списка: человек сохранил запись годовой давности, и она обязана
 * оказаться первой. Листай мы по `p.id`, она уехала бы в самый конец, то есть
 * туда, где её никто не найдёт.
 *
 * Фильтр блокировки стоит **на чтении**, а не на сохранении: заблокировали
 * автора после того, как его запись была сохранена, — она пропадает из списка,
 * строка в таблице остаётся. Разблокировали — вернулась. Правило одно на весь
 * проект: прячем там, где показываем, а не там, где записываем.
 *
 * Своих записей это тоже касается — точнее, не касается: закладка на себя
 * законна, это дневник.
 */
router.get('/', requireAuth, (req, res) => {
  const cursor = intParam(req.query.cursor);
  const viewerId = req.user.id;

  // Внешняя таблица закладок названа `bk`, потому что `bm` внутри
  // POST_COLUMNS занято одноимённым подзапросом, а `b` — подзапросом
  // блокировки. Формально они бы не столкнулись (вложенный алиас перекрывает
  // внешний), но читать такой запрос было бы гаданием.
  const rows = db.prepare(`
    SELECT ${POST_COLUMNS}, bk.id AS bookmark_id
    FROM bookmarks bk
    JOIN posts p ON p.id = bk.post_id
    JOIN users u ON u.id = p.author_id
    WHERE bk.user_id = :viewerId
      AND (:cursor IS NULL OR bk.id < :cursor)
      AND ${POST_VISIBLE_SQL}
    ORDER BY bk.id DESC
    LIMIT :limit
  `).all({ cursor, viewerId, limit: PAGE_SIZE + 1 });

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  res.json({
    posts: page.map(serialize),
    // Именно bookmark_id: вернуть сюда id записи — значит сломать порядок на
    // второй странице ровно тем способом, от которого спасал суррогатный id.
    nextCursor: hasMore ? page.at(-1).bookmark_id : null,
  });
});
