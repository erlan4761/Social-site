import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { db, nowIso } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSessionCookie, publicUser, SESSION_COOKIE,
} from '../auth.js';
import { PUBLIC_URL, sendMail } from '../email.js';
import * as v from '../validate.js';

export const router = Router();

const RESET_TTL_MS = 30 * 60_000;

router.post('/register', async (req, res, next) => {
  try {
    const uname = v.username(req.body?.username);
    const displayName = v.str(req.body?.displayName || req.body?.username, 'имя', { min: 1, max: 40 });
    const mail = v.email(req.body?.email);
    const pwd = v.password(req.body?.password);

    const takenName = db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname);
    if (takenName) return res.status(409).json({ error: 'Это имя пользователя уже занято' });

    const takenMail = db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail);
    if (takenMail) return res.status(409).json({ error: 'На этот email уже зарегистрирован аккаунт' });

    const info = db.prepare(`
      INSERT INTO users (username, display_name, bio, email, password_hash, created_at)
      VALUES (?, ?, '', ?, ?, ?)
    `).run(uname, displayName, mail, await hashPassword(pwd), nowIso());

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    setSessionCookie(res, createSession(user.id, req.get('user-agent')));
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

    setSessionCookie(res, createSession(user.id, req.get('user-agent')));
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

/* ─ Восстановление пароля ─────────────────────────────────────────────── */

router.post('/forgot-password', async (req, res, next) => {
  try {
    const mail = v.email(req.body?.email);
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(mail);

    // Ответ одинаковый независимо от того, нашёлся аккаунт или нет — иначе
    // форма превращается в способ проверить, кто здесь зарегистрирован.
    const reply = { ok: true, message: 'Если такой email зарегистрирован, на него отправлена ссылка' };

    if (user) {
      // Более ранние ссылки для этого аккаунта отзываем: активной должна
      // быть только последняя запрошенная.
      db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(user.id);

      const token = randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + RESET_TTL_MS);
      db.prepare('INSERT INTO password_resets (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(token, user.id, nowIso(), expires.toISOString());

      const link = `${PUBLIC_URL}/reset-password/${token}`;
      await sendMail({
        to: mail,
        subject: 'Восстановление пароля — Хроника',
        text: `Кто-то запросил сброс пароля для этого email.\n\nСсылка действует 30 минут:\n${link}\n\nЕсли это были не вы — просто игнорируйте письмо.`,
      });
    }

    res.json(reply);
  } catch (err) {
    next(err);
  }
});

function findValidReset(token) {
  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token);
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) return null;
  return row;
}

router.get('/reset-password/:token', (req, res) => {
  const valid = Boolean(findValidReset(req.params.token));
  res.json({ valid });
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const token = v.str(req.body?.token, 'токен', { min: 1, max: 200 });
    const pwd = v.password(req.body?.password);

    const reset = findValidReset(token);
    if (!reset) return res.status(400).json({ error: 'Ссылка недействительна или уже использована' });

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(pwd), reset.user_id);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE token = ?').run(nowIso(), token);

    // Если пароль меняют из-за утечки, старые сессии не должны продолжать работать.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
