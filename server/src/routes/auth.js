import { Router } from 'express';
import { db, nowIso } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSessionCookie, publicUser, SESSION_COOKIE,
} from '../auth.js';
import * as v from '../validate.js';

export const router = Router();

router.post('/register', async (req, res, next) => {
  try {
    const uname = v.username(req.body?.username);
    const displayName = v.str(req.body?.displayName || req.body?.username, 'имя', { min: 1, max: 40 });
    const pwd = v.password(req.body?.password);

    const taken = db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname);
    if (taken) return res.status(409).json({ error: 'Это имя пользователя уже занято' });

    const info = db.prepare(`
      INSERT INTO users (username, display_name, bio, password_hash, created_at)
      VALUES (?, ?, '', ?, ?)
    `).run(uname, displayName, await hashPassword(pwd), nowIso());

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    setSessionCookie(res, createSession(user.id));
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const uname = String(req.body?.username ?? '').trim().toLowerCase();
    const pwd = String(req.body?.password ?? '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);

    // Same response for unknown user and wrong password: no account enumeration.
    if (!user || !(await verifyPassword(pwd, user.password_hash))) {
      return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
    }

    setSessionCookie(res, createSession(user.id));
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user });
});
