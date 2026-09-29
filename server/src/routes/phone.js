import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { createSession, publicUser, setSessionCookie, verifyPassword } from '../auth.js';
import {
  checkCode, dropTicket, failTicket, hasPassword, issueTicket, normalizePhone, readTicket, sendCode,
} from '../phone.js';
import { notifyLogin } from '../notifications.js';
import * as v from '../validate.js';

/**
 * Вход и регистрация по номеру — как в Телеграме, одним путём:
 *
 *   1. start  — номер → SMS с кодом;
 *   2. verify — код верный → дальше одно из трёх:
 *        signed-in — аккаунт есть, пароля нет: сразу внутрь;
 *        password  — аккаунт есть и защищён паролем («двухэтапная проверка»);
 *        signup    — номер новый: придумать логин и имя;
 *   3. password / signup — закончить вход по билету из шага 2.
 *
 * Старт одинаков для знакомого и незнакомого номера: кто здесь
 * зарегистрирован, становится ясно только тому, кто получил код, — то есть
 * владельцу номера.
 */
export const router = Router();

/** Открыть сеанс. `announce` — известить о входе остальные устройства (не при регистрации). */
const signIn = (req, res, user, { announce = true } = {}) => {
  setSessionCookie(res, createSession(user.id, req.get('user-agent')));
  if (announce) notifyLogin(user.id, req.get('user-agent'));
  return publicUser(user);
};

router.post('/start', async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    res.json({ ok: true, phone, ...(await sendCode({ phone, purpose: 'login' })) });
  } catch (err) {
    next(err);
  }
});

router.post('/verify', (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    checkCode({ phone, purpose: 'login', code: req.body?.code });
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) return res.json({ status: 'signup', ticket: issueTicket('signup', phone) });
    if (hasPassword(user)) return res.json({ status: 'password', ticket: issueTicket('password', phone, user.id) });
    res.json({ status: 'signed-in', user: signIn(req, res, user) });
  } catch (err) {
    next(err);
  }
});

router.post('/password', async (req, res, next) => {
  try {
    const ticket = readTicket(req.body?.ticket, 'password');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ticket.user_id);
    const password = String(req.body?.password ?? '');
    if (!user || !password || !(await verifyPassword(password, user.password_hash))) {
      failTicket(ticket);
      return res.status(403).json({ error: 'Пароль не подходит' });
    }
    dropTicket(ticket.token);
    res.json({ user: signIn(req, res, user) });
  } catch (err) {
    next(err);
  }
});

router.post('/signup', (req, res, next) => {
  try {
    const ticket = readTicket(req.body?.ticket, 'signup');
    const username = v.username(req.body?.username);
    const displayName = v.str(req.body?.displayName || req.body?.username, 'имя', { min: 1, max: 40 });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'Это имя пользователя уже занято' });
    }
    // Пока человек придумывал логин, номер мог успеть кто-то занять.
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(ticket.phone)) {
      dropTicket(ticket.token);
      return res.status(409).json({ error: 'Этот номер уже зарегистрирован — войдите по нему заново' });
    }
    // Пароля нет (его можно задать потом как двухэтапную проверку), почты нет,
    // и вход по логину с паролем для такого аккаунта закрыт — только номер.
    const info = db.prepare(`
      INSERT INTO users (username, display_name, bio, email, password_hash, created_at, phone, password_login)
      VALUES (?, ?, '', NULL, '', ?, ?, 0)
    `).run(username, displayName, nowIso(), ticket.phone);
    dropTicket(ticket.token);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    // Первый вход нового аккаунта — не «вход с нового устройства»: других нет.
    res.status(201).json({ user: signIn(req, res, user, { announce: false }) });
  } catch (err) {
    next(err);
  }
});
