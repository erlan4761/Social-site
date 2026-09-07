import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import * as v from '../validate.js';

export const router = Router();

const PAGE_SIZE = 20;

const serialize = (row) => ({
  id: row.id,
  body: row.body,
  createdAt: row.created_at,
  author: {
    id: row.author_id,
    username: row.username,
    displayName: row.display_name,
  },
});

/**
 * Feed, newest first. Keyset pagination on id: `cursor` is the id of the last
 * post already shown, so pages stay stable while new posts arrive at the top.
 */
router.get('/', (req, res) => {
  const author = req.query.author ? String(req.query.author).toLowerCase() : null;
  const cursor = Number.parseInt(req.query.cursor, 10);
  const hasCursor = Number.isSafeInteger(cursor);

  const rows = db.prepare(`
    SELECT p.id, p.body, p.created_at, p.author_id, u.username, u.display_name
    FROM posts p JOIN users u ON u.id = p.author_id
    WHERE (:author IS NULL OR u.username = :author)
      AND (:cursor IS NULL OR p.id < :cursor)
    ORDER BY p.id DESC
    LIMIT :limit
  `).all({
    author,
    cursor: hasCursor ? cursor : null,
    limit: PAGE_SIZE + 1,
  });

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  res.json({
    posts: page.map(serialize),
    nextCursor: hasMore ? page.at(-1).id : null,
  });
});

router.post('/', requireAuth, (req, res, next) => {
  try {
    const body = v.str(req.body?.body, 'текст поста', { min: 1, max: 500 });
    const info = db.prepare('INSERT INTO posts (author_id, body, created_at) VALUES (?, ?, ?)')
      .run(req.user.id, body, nowIso());

    const row = db.prepare(`
      SELECT p.id, p.body, p.created_at, p.author_id, u.username, u.display_name
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.id = ?
    `).get(info.lastInsertRowid);

    res.status(201).json({ post: serialize(row) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'Некорректный id' });

  const post = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  if (post.author_id !== req.user.id) return res.status(403).json({ error: 'Это не ваш пост' });

  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  res.json({ ok: true });
});
