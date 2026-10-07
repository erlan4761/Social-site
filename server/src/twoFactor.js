import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { db, nowIso } from './db.js';

/**
 * Двухэтапная проверка кодом из приложения-аутентификатора (TOTP, RFC 6238):
 * Google Authenticator, «Яндекс Ключ», 1Password и любое другое. После пароля
 * (или кода из SMS) вход просит шесть цифр, которые меняются каждые 30 секунд.
 * Без внешних библиотек: HMAC-SHA1 есть в node:crypto, base32 — двадцать строк.
 *
 * Правила:
 * - код принимается в окне ±30 секунд (часы телефона и сервера расходятся);
 * - один и тот же код дважды не проходит: запоминается шаг последнего
 *   принятого (`totp_last_step`), подсмотренный код повторить нельзя;
 * - телефон потерян — десять резервных кодов, каждый одноразовый; в базе —
 *   только их SHA-256, как у паролей: утечка базы кодов не раскрывает;
 * - между паролем и кодом — билет на пять минут и пять попыток, как у входа
 *   по номеру: перебрать миллион кодов за пять попыток нельзя.
 */

export const TOTP_STEP_S = 30;
const DIGITS = 6;
const WINDOW = 1;
const TICKET_TTL_MS = 5 * 60_000;
const TICKET_ATTEMPTS = 5;
export const BACKUP_CODES = 10;
export const ISSUER = 'Duet';

/* ─ base32 (RFC 4648, без «=»): так секрет понимают приложения ─ */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Некорректный base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ─ HOTP/TOTP ─ */

/** Код для шага `step` (RFC 4226: HMAC-SHA1 и «динамическое усечение»). */
export function hotp(key, step, digits = DIGITS) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, '0');
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / TOTP_STEP_S);

/** Новый секрет — 160 бит, как советует RFC 4226. */
export const newSecret = () => base32Encode(randomBytes(20));

/** Адрес для QR-кода: его понимает любое приложение-аутентификатор. */
export const otpauthUri = (username, secret) =>
  `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(username)}` +
  `?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_S}`;

const sameCode = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Шаг, на котором код `code` верен для секрета, или null. `after` — шаг
 * последнего принятого кода: он и более ранние не проходят (повтор).
 */
export function matchTotp(secret, code, { after = -1, now = Date.now() } = {}) {
  const digits = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secret);
  const current = stepAt(now);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = current + d;
    if (step > after && sameCode(hotp(key, step), digits)) return step;
  }
  return null;
}

/* ─ Резервные коды ─ */

// Без похожих друг на друга знаков: 0/o, 1/l/i — их диктуют и переписывают с бумаги.
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const normalizeBackup = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashBackup = (code) => createHash('sha256').update(normalizeBackup(code)).digest('hex');

/** Новые десять кодов вместо прежних; сами коды показываются один раз. */
export function issueBackupCodes(userId) {
  const codes = Array.from({ length: BACKUP_CODES }, () => {
    const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO totp_backup_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)');
  for (const code of codes) insert.run(userId, hashBackup(code), nowIso());
  return codes;
}

export const backupCodesLeft = (userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM totp_backup_codes WHERE user_id = ? AND used_at IS NULL').get(userId).n;

/* ─ Проверка второго шага ─ */

export const twoFactorOn = (user) => Boolean(user?.totp_enabled_at && user.totp_secret);

/**
 * Код из приложения или резервный. Верный — отмечается использованным (шаг
 * TOTP или сам резервный код), так что второй раз он не пройдёт.
 * Возвращает, чем вошли: 'totp' | 'backup' | null.
 */
export function useSecondFactor(user, code) {
  const step = matchTotp(user.totp_secret, code, { after: user.totp_last_step ?? -1 });
  if (step != null) {
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
    return 'totp';
  }
  const normalized = normalizeBackup(code);
  if (normalized.length !== 8) return null;
  const row = db.prepare('SELECT rowid FROM totp_backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
    .get(user.id, hashBackup(normalized));
  if (!row) return null;
  db.prepare('UPDATE totp_backup_codes SET used_at = ? WHERE rowid = ?').run(nowIso(), row.rowid);
  return 'backup';
}

/* ─ Билет между первым шагом и кодом ─ */

export function issueTwoFactorTicket(userId) {
  const token = randomBytes(24).toString('base64url');
  db.prepare('DELETE FROM totp_tickets WHERE expires_at <= ?').run(nowIso());
  db.prepare('INSERT INTO totp_tickets (token, user_id, attempts, expires_at) VALUES (?, ?, 0, ?)')
    .run(token, userId, new Date(Date.now() + TICKET_TTL_MS).toISOString());
  return token;
}

export const readTwoFactorTicket = (token) =>
  typeof token === 'string' && token
    ? db.prepare('SELECT * FROM totp_tickets WHERE token = ? AND expires_at > ?').get(token, nowIso()) ?? null
    : null;

export const dropTwoFactorTicket = (token) => db.prepare('DELETE FROM totp_tickets WHERE token = ?').run(token);

/** Неверный код тратит попытку; пятая — и билета больше нет, вход заново. */
export function failTwoFactorTicket(row) {
  if (row.attempts + 1 >= TICKET_ATTEMPTS) dropTwoFactorTicket(row.token);
  else db.prepare('UPDATE totp_tickets SET attempts = attempts + 1 WHERE token = ?').run(row.token);
}
