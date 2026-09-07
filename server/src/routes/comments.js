import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';

export const router = Router();

router.delete('/:id', requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Некорректный id' });
  }

  const row = db.prepare(`
    SELECT c.author_id, p.author_id AS post_author_id
    FROM comments c JOIN posts p ON p.id = c.post_id
    WHERE c.id = ?
  `).get(id);

  if (!row) return res.status(404).json({ error: 'Комментарий не найден' });

  // Your own comment, or any comment under your own post — an author moderates
  // the thread beneath their record.
  const mine = row.author_id === req.user.id;
  const underMyPost = row.post_author_id === req.user.id;
  if (!mine && !underMyPost) {
    return res.status(403).json({ error: 'Можно удалять только свои комментарии' });
  }

  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  res.json({ ok: true });
});
