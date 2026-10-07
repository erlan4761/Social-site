import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { insertPost, postById } from './posts.js';
import * as v from '../validate.js';

/**
 * Отложенные записи ленты — «опубликовать позже», как отложенные сообщения
 * (scheduled.js). Только текст, по той же причине: файл, неделю пролежавший на
 * диске ради одной записи, — лишняя уборка, а анонсы и так пишут словами.
 *
 * Строка ждёт в scheduled_posts; такт планировщика публикует созревшие тем же
 * путём, что и обычную запись: теги, упоминания. Время публикации — время
 * записи: в ленте она встаёт наверх в свой час, а не в час, когда её написали.
 * Очередь видит и трогает только автор; чужое и несуществующее — одинаковый 404.
 *
 * Монтируется раньше /api/posts: иначе «scheduled» искался бы как id записи.
 */
export const router = Router();
router.use(requireAuth);

const NOT_FOUND = 'Отложенная запись не найдена';
const PENDING_MAX = 50;
const HORIZON_MS = 365 * 864e5;

function readSendAt(raw) {
  const at = typeof raw === 'string' ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) throw v.bad('Время публикации — дата в формате ISO');
  const ahead = at.getTime() - Date.now();
  if (ahead <= 0) throw v.bad('Время публикации уже прошло');
  if (ahead > HORIZON_MS) throw v.bad('Отложить можно не больше чем на год');
  return at.toISOString();
}

const serialize = (row) => ({ id: row.id, body: row.body, sendAt: row.send_at, createdAt: row.created_at });

const mine = (rawId, me) => {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return db.prepare('SELECT * FROM scheduled_posts WHERE id = ? AND author_id = ?').get(id, me) ?? null;
};

/**
 * Опубликовать строку очереди. Строка удаляется первой и в той же транзакции:
 * два прохода планировщика (или «сейчас» и такт) не опубликуют запись дважды.
 * Заблокированному модератором — молча ничего: писать он больше не может.
 */
export function publishScheduled(row) {
  let postId = null;
  db.exec('BEGIN');
  try {
    const taken = db.prepare('DELETE FROM scheduled_posts WHERE id = ?').run(row.id).changes;
    const banned = db.prepare('SELECT banned_at FROM users WHERE id = ?').get(row.author_id)?.banned_at;
    if (taken && !banned) postId = insertPost({ authorId: row.author_id, body: row.body });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return postId;
}

/** Публикует всё созревшее. Возвращает, сколько строк забрано из очереди. */
export function publishDuePosts(now = new Date()) {
  const due = db.prepare('SELECT * FROM scheduled_posts WHERE send_at <= ? ORDER BY send_at, id').all(now.toISOString());
  for (const row of due) {
    try {
      publishScheduled(row);
    } catch (err) {
      console.error('Отложенная запись не опубликована:', err);
    }
  }
  return due.length;
}

/** Своя очередь — ближайшие сверху. */
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM scheduled_posts WHERE author_id = ? ORDER BY send_at, id').all(req.user.id);
  res.json({ scheduled: rows.map(serialize) });
});

router.post('/', (req, res, next) => {
  try {
    const me = req.user.id;
    const body = v.str(req.body?.body, 'текст поста', { min: 1, max: 500 });
    const sendAt = readSendAt(req.body?.sendAt);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM scheduled_posts WHERE author_id = ?').get(me);
    if (n >= PENDING_MAX) return res.status(400).json({ error: `Отложенных записей не больше ${PENDING_MAX}` });
    const info = db.prepare('INSERT INTO scheduled_posts (author_id, body, send_at, created_at) VALUES (?, ?, ?, ?)')
      .run(me, body, sendAt, nowIso());
    res.status(201).json({ scheduled: serialize(db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(info.lastInsertRowid)) });
  } catch (err) {
    next(err);
  }
});

/** Изменить время (и, если прислан, текст). */
router.patch('/:id', (req, res, next) => {
  try {
    const row = mine(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: NOT_FOUND });
    const sendAt = req.body?.sendAt !== undefined ? readSendAt(req.body.sendAt) : row.send_at;
    const body = req.body?.body !== undefined ? v.str(req.body.body, 'текст поста', { min: 1, max: 500 }) : row.body;
    db.prepare('UPDATE scheduled_posts SET send_at = ?, body = ? WHERE id = ?').run(sendAt, body, row.id);
    res.json({ scheduled: serialize(db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(row.id)) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  const row = mine(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: NOT_FOUND });
  db.prepare('DELETE FROM scheduled_posts WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

/** «Опубликовать сейчас» — запись уходит в ленту немедленно. */
router.post('/:id/publish', (req, res, next) => {
  try {
    const row = mine(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: NOT_FOUND });
    const postId = publishScheduled(row);
    if (postId == null) return res.status(404).json({ error: NOT_FOUND });
    res.status(201).json({ post: postById(postId, req.user.id) });
  } catch (err) {
    next(err);
  }
});
