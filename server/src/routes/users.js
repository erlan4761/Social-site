import { Router } from 'express';
import multer from 'multer';
import { db, nowIso } from '../db.js';
import { requireAuth, publicUser } from '../auth.js';
import { deleteUpload, storeUpload } from '../media.js';
import * as v from '../validate.js';

export const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const followerCount = (id) => db.prepare('SELECT COUNT(*) AS c FROM follows WHERE followee_id = ?').get(id).c;
const followingCount = (id) => db.prepare('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?').get(id).c;

router.patch('/me', requireAuth, (req, res, next) => {
  try {
    const displayName = v.str(req.body?.displayName, 'имя', { min: 1, max: 40 });
    const bio = v.str(req.body?.bio ?? '', 'о себе', { max: 200 });

    db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?')
      .run(displayName, bio, req.user.id);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.put('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    const stored = await storeUpload(req.file.buffer, { allowedKinds: ['image'], into: 'avatar' });

    const previous = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.user.id);
    db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(stored.filename, req.user.id);
    deleteUpload('avatar', previous?.avatar_path);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.delete('/me/avatar', requireAuth, (req, res) => {
  const previous = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.user.id);
  db.prepare('UPDATE users SET avatar_path = NULL WHERE id = ?').run(req.user.id);
  deleteUpload('avatar', previous?.avatar_path);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

router.get('/:username', (req, res) => {
  const uname = String(req.params.username).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM posts WHERE author_id = ?').get(user.id);
  const followedByMe = req.user
    ? Boolean(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, user.id))
    : false;

  res.json({
    user: {
      ...publicUser(user),
      postCount: count,
      followerCount: followerCount(user.id),
      followingCount: followingCount(user.id),
      followedByMe,
    },
  });
});

router.put('/:username/follow', requireAuth, (req, res) => {
  const uname = String(req.params.username).toLowerCase();
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Нельзя подписаться на себя' });

  // Idempotent: subscribing twice is not an error, the row is simply already there.
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, target.id, nowIso());

  res.json({ followedByMe: true, followerCount: followerCount(target.id) });
});

router.delete('/:username/follow', requireAuth, (req, res) => {
  const uname = String(req.params.username).toLowerCase();
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, target.id);

  res.json({ followedByMe: false, followerCount: followerCount(target.id) });
});
