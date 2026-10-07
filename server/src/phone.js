import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { db, nowIso } from './db.js';
import { PUBLIC_URL } from './email.js';
import { SmsError, sendSms, smsConfigured } from './sms.js';
import { HttpError, bad } from './validate.js';

/**
 * Номер телефона и коды из SMS — для входа и регистрации «как в Телеграме»,
 * привязки номера к старому аккаунту и подтверждения удаления.
 *
 * Код — 6 цифр, живёт 5 минут, даёт 5 попыток; в базе только его хеш. Новый
 * код на тот же номер — не чаще раза в минуту и не больше пяти в час: каждое
 * SMS стоит денег, а без потолка форма входа стала бы способом слать чужому
 * номеру сообщения за счёт сайта.
 */

const CODE_TTL_MS = 5 * 60_000;
// Пауза перед новым кодом. Переменная — для смоук-теста: ждать минуту ему незачем.
const RESEND_MS = Number(process.env.SMS_RESEND_MS) || 60_000;
const HOURLY_MAX = 5;
const ATTEMPTS = 5;
const TICKET_TTL_MS = 15 * 60_000;
const TICKET_ATTEMPTS = 5;

const PHONE_RE = /^\+[1-9]\d{7,14}$/;

/** «+996 (555) 12-34-56», «00996…» → «+996555123456» (E.164) или 400. */
export function normalizePhone(raw) {
  if (typeof raw !== 'string') throw bad('Укажите номер телефона');
  let phone = raw.trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!PHONE_RE.test(phone)) throw bad('Номер — в международном формате, с кодом страны: +996 555 123 456');
  return phone;
}

const hashCode = (salt, code) => createHash('sha256').update(`${salt}:${code}`).digest();

function smsText(code) {
  const text = `Duet: код ${code}. Никому его не сообщайте.`;
  // Последняя строка — для автоподстановки кода браузером (WebOTP): только
  // для настоящего https-адреса сайта, иначе браузер её всё равно не примет.
  const host = PUBLIC_URL.startsWith('https://') ? new URL(PUBLIC_URL).host : null;
  return host ? `${text}\n\n@${host} #${code}` : text;
}

/**
 * Выслать код. `purpose` — зачем он: login (вход и регистрация), link
 * (привязать номер), delete (удалить аккаунт без пароля).
 */
export async function sendCode({ phone, purpose, userId = null }) {
  if (!smsConfigured) throw new HttpError(503, 'Вход по SMS на этом сервере не настроен');

  const now = Date.now();
  const last = db.prepare('SELECT created_at FROM phone_codes WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1')
    .get(phone, purpose);
  if (last) {
    const wait = RESEND_MS - (now - Date.parse(last.created_at));
    if (wait > 0) throw new HttpError(429, `Новый код можно запросить через ${Math.ceil(wait / 1000)} с`);
  }
  const hour = db.prepare('SELECT COUNT(*) AS c FROM phone_codes WHERE phone = ? AND created_at > ?')
    .get(phone, new Date(now - 3_600_000).toISOString()).c;
  if (hour >= HOURLY_MAX) throw new HttpError(429, 'Слишком много кодов на этот номер — попробуйте через час');

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = randomBytes(16).toString('hex');
  // Действует только последний код: прежние на этот номер и цель гаснут.
  db.prepare('UPDATE phone_codes SET used_at = ? WHERE phone = ? AND purpose = ? AND used_at IS NULL').run(nowIso(), phone, purpose);
  const info = db.prepare(`
    INSERT INTO phone_codes (phone, purpose, user_id, code_hash, salt, attempts, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(phone, purpose, userId, hashCode(salt, code).toString('hex'), salt, new Date(now + CODE_TTL_MS).toISOString(), nowIso());

  try {
    await sendSms(phone, smsText(code));
  } catch (err) {
    db.prepare('DELETE FROM phone_codes WHERE id = ?').run(info.lastInsertRowid);
    if (err instanceof SmsError) console.error('SMS не отправлено:', err.message);
    throw new HttpError(502, 'Не удалось отправить SMS — попробуйте позже');
  }
  return { expiresIn: CODE_TTL_MS / 1000, resendIn: RESEND_MS / 1000 };
}

/** Проверить код; верный гасится. Неверный — 400 с числом оставшихся попыток. */
export function checkCode({ phone, purpose, code, userId = null }) {
  const row = db.prepare(`
    SELECT * FROM phone_codes
    WHERE phone = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
      AND (? IS NULL OR user_id = ?)
    ORDER BY id DESC LIMIT 1
  `).get(phone, purpose, nowIso(), userId, userId);
  if (!row) throw bad('Код устарел или не запрашивался — запросите новый');
  if (row.attempts >= ATTEMPTS) throw bad('Слишком много попыток — запросите новый код');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) throw bad('Код — 6 цифр из SMS');

  const ok = timingSafeEqual(hashCode(row.salt, code.trim()), Buffer.from(row.code_hash, 'hex'));
  if (!ok) {
    db.prepare('UPDATE phone_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = ATTEMPTS - row.attempts - 1;
    throw bad(left > 0 ? `Неверный код. Осталось попыток: ${left}` : 'Неверный код. Запросите новый');
  }
  db.prepare('UPDATE phone_codes SET used_at = ? WHERE id = ?').run(nowIso(), row.id);
}

/* ─ Билеты ───────────────────────────────────────────────────────────────
 * Код подтверждён, но вход ещё не закончен: новому номеру нужно придумать
 * логин и имя, а у аккаунта с паролем — ввести его. Билет — это «номер уже
 * проверен» на 15 минут, чтобы не просить код второй раз.
 */

export function issueTicket(kind, phone, userId = null) {
  const token = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO phone_tickets (token, kind, phone, user_id, attempts, expires_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(token, kind, phone, userId, new Date(Date.now() + TICKET_TTL_MS).toISOString());
  return token;
}

export function readTicket(token, kind) {
  const row = typeof token === 'string'
    ? db.prepare('SELECT * FROM phone_tickets WHERE token = ? AND kind = ? AND expires_at > ?').get(token, kind, nowIso())
    : null;
  if (!row) throw bad('Вход устарел — начните заново с номера телефона');
  return row;
}

export const dropTicket = (token) => db.prepare('DELETE FROM phone_tickets WHERE token = ?').run(token);

/** Неверный пароль по билету: после пяти — билет сгорает, начинать с кода. */
export function failTicket(row) {
  if (row.attempts + 1 >= TICKET_ATTEMPTS) dropTicket(row.token);
  else db.prepare('UPDATE phone_tickets SET attempts = attempts + 1 WHERE token = ?').run(row.token);
}

/** Есть ли у аккаунта пароль (у зарегистрированных по номеру — не обязательно). */
export const hasPassword = (row) => typeof row.password_hash === 'string' && row.password_hash.startsWith('scrypt$');
