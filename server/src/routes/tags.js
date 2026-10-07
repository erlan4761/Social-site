import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { tagFromParam } from '../hashtags.js';
import { POST_VISIBLE_SQL, REPOST_VISIBLE_SQL } from './posts.js';

export const router = Router();

const TRENDING_DAYS = 7;
const TRENDING_MAX = 10;

/**
 * Популярные теги — за последнюю неделю, по числу записей. Записи тех, с кем
 * смотрящий в блокировке, не считаются: тег, который весь держится на них, вёл
 * бы на пустую страницу.
 *
 * Подпись — MAX(label): у «пленка» и «плёнка» ключ один, а «ё» в Юникоде
 * старше «е», так что побеждает написание с «ё».
 */
router.get('/trending', (req, res) => {
  const since = new Date(Date.now() - TRENDING_DAYS * 24 * 60 * 60_000).toISOString();
  const tags = db.prepare(`
    SELECT t.tag, MAX(t.label) AS label, COUNT(*) AS count
    FROM post_tags t JOIN posts p ON p.id = t.post_id
    WHERE p.created_at >= :since AND ${POST_VISIBLE_SQL}
    GROUP BY t.tag
    ORDER BY count DESC, t.tag
    LIMIT :limit
  `).all({ since, viewerId: req.user?.id ?? null, limit: TRENDING_MAX });
  res.json({ tags });
});

/**
 * Теги, за которыми человек следит, — свежие подписки сверху. Записи с ними
 * приходят во вкладку «Подписки» вместе с записями людей. До ста тегов:
 * больше — это уже не подписка, а вся лента.
 */
const FOLLOWED_MAX = 100;

router.get('/followed', requireAuth, (req, res) => {
  const tags = db.prepare(`
    SELECT tf.tag,
           COALESCE((SELECT MAX(pt.label) FROM post_tags pt WHERE pt.tag = tf.tag), tf.tag) AS label
    FROM tag_follows tf WHERE tf.user_id = ?
    ORDER BY tf.created_at DESC, tf.tag
  `).all(req.user.id);
  res.json({ tags });
});

router.put('/:tag/follow', requireAuth, (req, res) => {
  const tag = tagFromParam(req.params.tag);
  if (!tag) return res.status(400).json({ error: 'Некорректный тег' });
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM tag_follows WHERE user_id = ?').get(req.user.id);
  const already = db.prepare('SELECT 1 FROM tag_follows WHERE user_id = ? AND tag = ?').get(req.user.id, tag);
  if (!already && n >= FOLLOWED_MAX) return res.status(400).json({ error: `Следить можно не больше чем за ${FOLLOWED_MAX} тегами` });
  db.prepare('INSERT OR IGNORE INTO tag_follows (user_id, tag, created_at) VALUES (?, ?, ?)').run(req.user.id, tag, nowIso());
  res.json({ followedByMe: true });
});

router.delete('/:tag/follow', requireAuth, (req, res) => {
  const tag = tagFromParam(req.params.tag);
  if (!tag) return res.status(400).json({ error: 'Некорректный тег' });
  db.prepare('DELETE FROM tag_follows WHERE user_id = ? AND tag = ?').run(req.user.id, tag);
  res.json({ followedByMe: false });
});

/** Шапка страницы тега: подпись и сколько всего записей. Незнакомый тег — 0, а не 404: его просто ещё не ставили. */
router.get('/:tag', (req, res) => {
  const tag = tagFromParam(req.params.tag);
  if (!tag) return res.status(400).json({ error: 'Некорректный тег' });
  const row = db.prepare(`
    SELECT MAX(t.label) AS label, COUNT(*) AS count
    FROM post_tags t JOIN posts p ON p.id = t.post_id
    WHERE t.tag = :tag AND ${POST_VISIBLE_SQL} AND ${REPOST_VISIBLE_SQL}
  `).get({ tag, viewerId: req.user?.id ?? null });
  const followedByMe = req.user
    ? Boolean(db.prepare('SELECT 1 FROM tag_follows WHERE user_id = ? AND tag = ?').get(req.user.id, tag))
    : false;
  res.json({ tag, label: row.label ?? String(req.params.tag).replace(/^#/, '').toLowerCase(), count: row.count, followedByMe });
});
