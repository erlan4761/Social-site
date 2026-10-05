import { Router } from 'express';
import { db } from '../db.js';
import { blockPairSql } from '../blocks.js';
import { tagFromParam } from '../hashtags.js';
import { REPOST_VISIBLE_SQL } from './posts.js';

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
    WHERE p.created_at >= :since AND ${blockPairSql('p.author_id')}
    GROUP BY t.tag
    ORDER BY count DESC, t.tag
    LIMIT :limit
  `).all({ since, viewerId: req.user?.id ?? null, limit: TRENDING_MAX });
  res.json({ tags });
});

/** Шапка страницы тега: подпись и сколько всего записей. Незнакомый тег — 0, а не 404: его просто ещё не ставили. */
router.get('/:tag', (req, res) => {
  const tag = tagFromParam(req.params.tag);
  if (!tag) return res.status(400).json({ error: 'Некорректный тег' });
  const row = db.prepare(`
    SELECT MAX(t.label) AS label, COUNT(*) AS count
    FROM post_tags t JOIN posts p ON p.id = t.post_id
    WHERE t.tag = :tag AND ${blockPairSql('p.author_id')} AND ${REPOST_VISIBLE_SQL}
  `).get({ tag, viewerId: req.user?.id ?? null });
  res.json({ tag, label: row.label ?? String(req.params.tag).replace(/^#/, '').toLowerCase(), count: row.count });
});
