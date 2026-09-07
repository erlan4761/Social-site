import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import * as v from '../validate.js';

export const router = Router();

const PAGE_SIZE = 20;
const COMMENT_CAP = 500;

const serialize = (row) => ({
  id: row.id,
  body: row.body,
  createdAt: row.created_at,
  likeCount: row.like_count,
  commentCount: row.comment_count,
  likedByMe: Boolean(row.liked_by_me),
  author: {
    id: row.author_id,
    username: row.username,
    displayName: row.display_name,
  },
});

const serializeComment = (row) => ({
  id: row.id,
  postId: row.post_id,
  body: row.body,
  createdAt: row.created_at,
  author: {
    id: row.author_id,
    username: row.username,
    displayName: row.display_name,
  },
});

// Counts live in subqueries rather than denormalised columns: one source of
// truth, and the per-post indexes keep it cheap at this scale.
const POST_COLUMNS = `
  p.id, p.body, p.created_at, p.author_id, u.username, u.display_name,
  (SELECT COUNT(*) FROM likes    l WHERE l.post_id = p.id) AS like_count,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
  EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = :viewerId) AS liked_by_me
`;

/** Numeric route param, or null when it is not a usable id. */
function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Feed, newest first. Keyset pagination on id: `cursor` is the id of the last
 * post already shown, so pages stay stable while new posts arrive at the top.
 */
router.get('/', (req, res) => {
  const author = req.query.author ? String(req.query.author).toLowerCase() : null;
  const cursor = intParam(req.query.cursor);
  const onlyFollowing = req.query.feed === 'following';

  if (onlyFollowing && !req.user) {
    return res.status(401).json({ error: 'Войдите, чтобы смотреть подписки' });
  }

  const rows = db.prepare(`
    SELECT ${POST_COLUMNS}
    FROM posts p JOIN users u ON u.id = p.author_id
    WHERE (:author IS NULL OR u.username = :author)
      AND (:cursor IS NULL OR p.id < :cursor)
      AND (
        :onlyFollowing = 0
        OR p.author_id = :viewerId
        OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = :viewerId)
      )
    ORDER BY p.id DESC
    LIMIT :limit
  `).all({
    author,
    cursor,
    viewerId: req.user?.id ?? null,
    onlyFollowing: onlyFollowing ? 1 : 0,
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
      SELECT ${POST_COLUMNS}
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.id = :id
    `).get({ id: info.lastInsertRowid, viewerId: req.user.id });

    res.status(201).json({ post: serialize(row) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Некорректный id' });

  const post = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  if (post.author_id !== req.user.id) return res.status(403).json({ error: 'Это не ваш пост' });

  // Likes and comments go with it via ON DELETE CASCADE.
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* ─ Лайки ──────────────────────────────────────────────────────────────── */

const likeCount = (postId) =>
  db.prepare('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?').get(postId).c;

router.put('/:id/like', requireAuth, (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Некорректный id' });

  const exists = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Пост не найден' });

  // Idempotent: liking twice is not an error, the row is simply already there.
  db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, id, nowIso());

  res.json({ likeCount: likeCount(id), likedByMe: true });
});

router.delete('/:id/like', requireAuth, (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Некорректный id' });

  const exists = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Пост не найден' });

  db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, id);

  res.json({ likeCount: likeCount(id), likedByMe: false });
});

/* ─ Комментарии ────────────────────────────────────────────────────────── */

router.get('/:id/comments', (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Некорректный id' });

  const exists = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Пост не найден' });

  // Oldest first — a comment thread reads as a conversation, not as a feed.
  const rows = db.prepare(`
    SELECT c.id, c.post_id, c.body, c.created_at, c.author_id, u.username, u.display_name
    FROM comments c JOIN users u ON u.id = c.author_id
    WHERE c.post_id = ?
    ORDER BY c.id ASC
    LIMIT ?
  `).all(id, COMMENT_CAP);

  res.json({ comments: rows.map(serializeComment) });
});

router.post('/:id/comments', requireAuth, (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });

    const exists = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'Пост не найден' });

    const body = v.str(req.body?.body, 'текст комментария', { min: 1, max: 300 });
    const info = db.prepare(
      'INSERT INTO comments (post_id, author_id, body, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, req.user.id, body, nowIso());

    const row = db.prepare(`
      SELECT c.id, c.post_id, c.body, c.created_at, c.author_id, u.username, u.display_name
      FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.id = ?
    `).get(info.lastInsertRowid);

    res.status(201).json({ comment: serializeComment(row) });
  } catch (err) {
    next(err);
  }
});
