import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { db, nowIso } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSessionCookie, selfUser, SESSION_COOKIE, assertNotBanned,
} from '../auth.js';
import { notifyLogin } from '../notifications.js';
import {
  backupCodesLeft, dropTwoFactorTicket, failTwoFactorTicket, issueTwoFactorTicket, readTwoFactorTicket, twoFactorOn,
  useSecondFactor,
} from '../twoFactor.js';
import { PUBLIC_URL, sendMail } from '../email.js';
import * as v from '../validate.js';

export const router = Router();

const RESET_TTL_MS = 30 * 60_000;

/**
 * Регистрация по логину и почте закрыта: новые аккаунты — только по номеру
 * телефона (routes/phone.js). Ответ 410 и подсказка, куда идти, — для старых
 * клиентов и для тех, кто стучится сюда напрямую.
 */
router.post('/register', (_req, res) => {
  res.status(410).json({ error: 'Регистрация — только по номеру телефона' });
});

router.post('/login', async (req, res, next) => {
  try {
    const uname = String(req.body?.username ?? '').trim().toLowerCase();
    const pwd = String(req.body?.password ?? '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);

    // Same response for unknown user and wrong password: no account enumeration.
    // Аккаунт, созданный по номеру, по логину не входит: его пароль — второй
    // шаг после кода из SMS, а не замена ему.
    if (!user || !user.password_login || !(await verifyPassword(pwd, user.password_hash))) {
      return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
    }
    // После пароля: подбирающий пароль не узнает, заблокирован ли аккаунт.
    assertNotBanned(user);
    // Включён вход с кодом — сеанса ещё нет, только билет на второй шаг.
    if (twoFactorOn(user)) return res.json({ status: 'two-factor', ticket: issueTwoFactorTicket(user.id) });

    setSessionCookie(res, createSession(user.id, req.get('user-agent')));
    notifyLogin(user.id, req.get('user-agent'));
    res.json({ user: selfUser(user) });
  } catch (err) {
    next(err);
  }
});

/**
 * Второй шаг входа: код из приложения или резервный. Один путь для входа по
 * логину и по номеру — билет выдают оба. Неверный код тратит попытку билета.
 */
router.post('/2fa', (req, res, next) => {
  try {
    const ticket = readTwoFactorTicket(req.body?.ticket);
    if (!ticket) return res.status(410).json({ error: 'Время на ввод кода вышло — войдите заново' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ticket.user_id);
    const how = user && twoFactorOn(user) ? useSecondFactor(user, req.body?.code) : null;
    if (!how) {
      failTwoFactorTicket(ticket);
      return res.status(403).json({ error: 'Код не подходит' });
    }
    dropTwoFactorTicket(ticket.token);
    assertNotBanned(user);
    setSessionCookie(res, createSession(user.id, req.get('user-agent')));
    notifyLogin(user.id, req.get('user-agent'));
    // Вошли резервным — пусть человек видит, сколько их осталось.
    res.json({ user: selfUser(user), ...(how === 'backup' ? { backupCodesLeft: backupCodesLeft(user.id) } : {}) });
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
        subject: 'Восстановление пароля — Duet',
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
