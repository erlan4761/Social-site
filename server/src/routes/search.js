import { Router } from 'express';
import { db } from '../db.js';
import { blockPairSql } from '../blocks.js';
import { ftsQuery } from '../search.js';
import { POST_COLUMNS, serialize } from './posts.js';

export const router = Router();

const PAGE_SIZE = 20;

// Потолок длины запроса. Строка обрезается, а не отвергается: человек,
// вставивший в поиск целый абзац, промахнулся, но 400 ему ничего не объяснит —
// показать результаты по началу абзаца честнее. Дальше всё равно берётся не
// больше восьми термов (см. ftsQuery).
const MAX_QUERY = 100;

/** Numeric query param, or null when it is not a usable id. */
function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Полнотекстовый поиск по записям.
 *
 * Порядок — `p.id DESC`, хронологический, а не по релевантности `bm25`: это
 * дневник, а не поисковик, и «когда я это написал» — единственный порядок,
 * который здесь осмыслен. Он же сохраняет keyset-пагинацию, общую для всех
 * лент проекта; сортировка по релевантности потребовала бы offset-страниц,
 * которых в проекте нет нигде.
 *
 * Сниппет сервером не отдаётся намеренно: в индексе лежит нормализованная
 * копия текста (`ё`→`е`), и `snippet()` показал бы «пленка» там, где записано
 * «плёнка». Подсветку делает клиент по тем же термам, по оригинальному тексту.
 */
router.get('/posts', (req, res) => {
  // Массив (?q=a&q=b) и отсутствие параметра сводятся к строке здесь же:
  // дальше по коду q — всегда строка, и ветвиться на его тип не нужно.
  const q = String(req.query.q ?? '').trim().slice(0, MAX_QUERY);
  const author = req.query.author ? String(req.query.author).toLowerCase() : null;
  const cursor = intParam(req.query.cursor);

  // Сырой текст в MATCH не попадает никогда: у FTS5 свой синтаксис, и обычная
  // человеческая строка легко оказывается в нём ошибкой. Выражение строит
  // ftsQuery(), и оно уходит параметром, а не склейкой.
  const match = ftsQuery(q);

  // Пустой или бессмысленный запрос («***», одни пробелы) — не ошибка, а
  // промежуточное состояние строки ввода: поле поиска дёргается на каждый
  // символ. Отвечаем пустым списком и в базу не ходим.
  if (match === null) return res.json({ posts: [], nextCursor: null, query: q });

  // Все параметры именованные: blockPairSql() и POST_COLUMNS ждут :viewerId,
  // а смешивать именованные с позиционными в node:sqlite — лишний повод
  // ошибиться порядком.
  const rows = db.prepare(`
    SELECT ${POST_COLUMNS}
    FROM posts p
    JOIN users u ON u.id = p.author_id
    JOIN posts_fts f ON f.rowid = p.id
    WHERE posts_fts MATCH :match
      AND (:author IS NULL OR u.username = :author)
      AND (:cursor IS NULL OR p.id < :cursor)
      AND ${blockPairSql('p.author_id')}
    ORDER BY p.id DESC
    LIMIT :limit
  `).all({
    match,
    author,
    cursor,
    viewerId: req.user?.id ?? null,
    limit: PAGE_SIZE + 1,
  });

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  // query возвращается тем же, по чему искали (обрезанным и без крайних
  // пробелов): клиент подсвечивает найденное по этой строке, и расхождение с
  // содержимым поля ввода — это подсветка не того, что нашлось.
  res.json({
    posts: page.map(serialize),
    nextCursor: hasMore ? page.at(-1).id : null,
    query: q,
  });
});
