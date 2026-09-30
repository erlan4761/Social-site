import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { deleteUpload, publicUrl } from '../media.js';
import { dropDeadStreams } from '../live.js';
import * as v from '../validate.js';

/**
 * Панель модератора: жалобы, сгруппированные по тому, на что жалуются, и три
 * решения — «оставить» (жалоба отклонена), «удалить» (запись или комментарий)
 * и «заблокировать» автора. Модератора назначает владелец сервера командой
 * `npm run moderator -- <логин>` — через интерфейс его не получить.
 *
 * Блокировка модератором — не «блокировка» между двумя людьми, а запрет на
 * вход: все сеансы закрываются, вход по логину и по номеру отвечает «аккаунт
 * заблокирован». Записи остаются, пока модератор не удалит их отдельно — так
 * решение обратимо: снял блокировку — человек вернулся со всем, что было.
 */
export const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (!req.user.moderator) return res.status(403).json({ error: 'Только для модераторов' });
  next();
});

const ACTIONS = ['dismiss', 'remove', 'ban'];
const TYPES = ['post', 'comment', 'user'];

const author = (row) => (row ? { id: row.id, username: row.username, displayName: row.display_name, avatarUrl: publicUrl('avatar', row.avatar_path) } : null);
const userRow = (id) => db.prepare('SELECT id, username, display_name, avatar_path, banned_at, moderator FROM users WHERE id = ?').get(id);

/** Что показать модератору о предмете жалобы — и чей он. null — уже удалён. */
function subject(type, id) {
  if (type === 'post') {
    const p = db.prepare('SELECT id, author_id, body, created_at, media_path, media_type FROM posts WHERE id = ?').get(id);
    if (!p) return null;
    const a = userRow(p.author_id);
    return { authorId: p.author_id, author: author(a), text: p.body, createdAt: p.created_at, media: p.media_path ? publicUrl('media', p.media_path) : null, banned: Boolean(a?.banned_at) };
  }
  if (type === 'comment') {
    const c = db.prepare('SELECT id, author_id, post_id, body, created_at FROM comments WHERE id = ?').get(id);
    if (!c) return null;
    const a = userRow(c.author_id);
    return { authorId: c.author_id, author: author(a), text: c.body, createdAt: c.created_at, postId: c.post_id, banned: Boolean(a?.banned_at) };
  }
  const u = db.prepare('SELECT id, username, display_name, avatar_path, bio, created_at, banned_at FROM users WHERE id = ?').get(id);
  if (!u) return null;
  return { authorId: u.id, author: author(u), text: u.bio ?? '', createdAt: u.created_at, banned: Boolean(u.banned_at) };
}

/**
 * Жалобы по предметам: сколько, по каким причинам, последние комментарии
 * жалующихся. Открытые — сверху те, на что жалуются чаще.
 */
router.get('/reports', (req, res) => {
  const resolved = req.query.status === 'resolved';
  const rows = db.prepare(`
    SELECT r.*, u.username AS reporter
    FROM reports r JOIN users u ON u.id = r.reporter_id
    WHERE r.resolved_at IS ${resolved ? 'NOT NULL' : 'NULL'}
    ORDER BY r.created_at DESC
  `).all();

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.target_type}:${r.target_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        targetType: r.target_type, targetId: r.target_id, count: 0, reasons: {}, notes: [], lastAt: r.created_at,
        resolution: r.resolution ?? null, resolvedAt: r.resolved_at ?? null,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    g.reasons[r.reason] = (g.reasons[r.reason] ?? 0) + 1;
    if (r.note && g.notes.length < 5) g.notes.push({ reporter: r.reporter, reason: r.reason, note: r.note, createdAt: r.created_at });
  }
  const list = [...groups.values()]
    .map((g) => ({ ...g, subject: subject(g.targetType, g.targetId) }))
    .sort((a, b) => (resolved ? b.resolvedAt.localeCompare(a.resolvedAt) : b.count - a.count || b.lastAt.localeCompare(a.lastAt)))
    .slice(0, 100);
  res.json({ reports: list });
});

function ban(userId, reason) {
  db.prepare('UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?').run(nowIso(), reason, userId);
  // Вышел отовсюду сразу: сеансы и живые потоки.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  dropDeadStreams();
}

/** Решение по всем открытым жалобам на один предмет. */
router.post('/resolve', (req, res, next) => {
  try {
    const { targetType, action } = req.body ?? {};
    const targetId = Number(req.body?.targetId);
    if (!TYPES.includes(targetType) || !Number.isSafeInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'Неизвестный предмет жалобы' });
    }
    if (!ACTIONS.includes(action)) return res.status(400).json({ error: `Решение — одно из: ${ACTIONS.join(', ')}` });
    const open = db.prepare('SELECT COUNT(*) AS c FROM reports WHERE target_type = ? AND target_id = ? AND resolved_at IS NULL')
      .get(targetType, targetId).c;
    if (open === 0) return res.status(404).json({ error: 'Открытых жалоб на это нет' });

    const s = subject(targetType, targetId);
    if (action !== 'dismiss' && !s) return res.status(404).json({ error: 'Этого уже нет — жалобу можно только закрыть' });

    if (action === 'remove') {
      if (targetType === 'user') return res.status(400).json({ error: 'Человека не удалить — только заблокировать' });
      if (targetType === 'post') {
        const post = db.prepare('SELECT media_path FROM posts WHERE id = ?').get(targetId);
        db.prepare('DELETE FROM posts WHERE id = ?').run(targetId);
        deleteUpload('media', post.media_path);
      } else {
        db.prepare('DELETE FROM comments WHERE id = ?').run(targetId);
      }
    }
    if (action === 'ban') {
      const target = userRow(s.authorId);
      if (target.id === req.user.id) return res.status(400).json({ error: 'Себя не заблокировать' });
      if (target.moderator) return res.status(400).json({ error: 'Модератора не заблокировать — сначала снимите с него права' });
      const note = v.str(req.body?.note ?? '', 'причина', { max: 200 });
      ban(target.id, note || `жалоба на ${targetType} #${targetId}`);
    }

    const resolution = { dismiss: 'dismissed', remove: 'removed', ban: 'banned' }[action];
    db.prepare(`
      UPDATE reports SET resolved_at = ?, resolution = ?, resolved_by = ?
      WHERE target_type = ? AND target_id = ? AND resolved_at IS NULL
    `).run(nowIso(), resolution, req.user.id, targetType, targetId);
    console.warn(`⚑ Модератор @${req.user.username}: ${targetType} #${targetId} — ${resolution}`);
    res.json({ ok: true, resolution, resolved: open });
  } catch (err) {
    next(err);
  }
});

router.get('/banned', (_req, res) => {
  const rows = db.prepare('SELECT id, username, display_name, avatar_path, banned_at, ban_reason FROM users WHERE banned_at IS NOT NULL ORDER BY banned_at DESC').all();
  res.json({ users: rows.map((u) => ({ ...author(u), bannedAt: u.banned_at, reason: u.ban_reason ?? '' })) });
});

router.delete('/banned/:username', (req, res) => {
  const info = db.prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE username = ? AND banned_at IS NOT NULL')
    .run(String(req.params.username).toLowerCase());
  if (info.changes === 0) return res.status(404).json({ error: 'Такого заблокированного нет' });
  res.json({ ok: true });
});
