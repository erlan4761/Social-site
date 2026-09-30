import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, nowIso } from './db.js';
import { publicUrl } from './media.js';

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;
export const SESSION_COOKIE = 'sid';

/**
 * Сеанс закрывается, если им не пользовались дольше срока, — как «Автоматически
 * завершать сеансы» в Телеграме. Срок выбирает владелец; по умолчанию месяц.
 * Пока сеансом пользуются, срок сдвигается вперёд — не чаще раза в час, чтобы
 * не писать в базу на каждый запрос (и кука продлевается вместе с ним).
 */
export const SESSION_TTL_OPTIONS = [7, 30, 90, 180, 365];
export const DEFAULT_TTL_DAYS = 30;
const EXTEND_EVERY_MS = 60 * 60_000;
export const ttlDaysOf = (user) => (SESSION_TTL_OPTIONS.includes(user?.session_ttl_days) ? user.session_ttl_days : DEFAULT_TTL_DAYS);
const expiryFrom = (ms, days) => new Date(ms + days * 864e5);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

/** `userAgent` — заголовок запроса входа: по нему сеанс узнают в настройках. */
export function createSession(userId, userAgent = null) {
  const token = randomBytes(32).toString('base64url');
  const days = ttlDaysOf(db.prepare('SELECT session_ttl_days FROM users WHERE id = ?').get(userId));
  const now = nowIso();
  const expires = expiryFrom(Date.now(), days);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, userId, now, expires.toISOString(), userAgent ? String(userAgent).slice(0, 300) : null, now);
  return { token, expires };
}

/** Истёкшие сеансы — прочь; с ними каскадом уходят их пуш-подписки. Зовёт такт планировщика. */
export function sweepSessions() {
  return Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso()).changes);
}

/**
 * Новый срок для всех сеансов человека — от их последнего использования.
 * Те, что уже дольше неактивны, закрываются сразу. Возвращает, сколько закрыто.
 */
export function applySessionTtl(userId, days) {
  const rows = db.prepare('SELECT token, created_at, last_used_at FROM sessions WHERE user_id = ?').all(userId);
  const update = db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?');
  for (const r of rows) update.run(expiryFrom(Date.parse(r.last_used_at ?? r.created_at), days).toISOString(), r.token);
  return Number(db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(userId, nowIso()).changes);
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function setSessionCookie(res, session) {
  res.cookie(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: session.expires,
    path: '/',
  });
}

/** Не чаще раза в минуту на человека: loadUser стоит перед каждым запросом,
 *  включая статику и опрос счётчиков, и запись на каждый из них — это запись
 *  на каждый клик. Минутная точность для «был(а) в сети» — с запасом. */
const SEEN_EVERY_MS = 60_000;
const touchSeen = db.prepare(`
  UPDATE users SET last_seen_at = :now
  WHERE id = :id AND (last_seen_at IS NULL OR last_seen_at < :stale)
`);

function touchLastSeen(userId) {
  const now = Date.now();
  touchSeen.run({
    id: userId,
    now: new Date(now).toISOString(),
    stale: new Date(now - SEEN_EVERY_MS).toISOString(),
  });
}

/** Populates req.user when a valid, unexpired session cookie is present. */
export function loadUser(req, res, next) {
  req.user = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.bio, u.avatar_path, u.created_at, u.moderator, u.banned_at, u.session_ttl_days,
             s.expires_at, s.last_used_at, s.created_at AS session_created_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);

    // Заблокированный модератором не входит: блокировка и так закрывает
    // сеансы, а эта проверка — на случай, если какой-то уцелел.
    if (row && new Date(row.expires_at) > new Date() && !row.banned_at) {
      // Флаг модератора — только в собственном «я»: другим его не показывают.
      req.user = selfUser(row);
      req.sessionToken = token;
      touchLastSeen(row.id);
      // Сеансом пользуются — срок сдвигается вперёд, раз в час, вместе с кукой.
      const now = Date.now();
      if (now - Date.parse(row.last_used_at ?? row.session_created_at) >= EXTEND_EVERY_MS) {
        const expires = expiryFrom(now, ttlDaysOf(row));
        db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token = ?')
          .run(new Date(now).toISOString(), expires.toISOString(), token);
        setSessionCookie(res, { token, expires });
      }
    } else if (row) {
      destroySession(token);
    }
  }
  next();
}

/** Вход заблокированного модератором — 403. Проверять после пароля или кода. */
export function assertNotBanned(user) {
  if (user?.banned_at) throw Object.assign(new Error('Аккаунт заблокирован модератором'), { status: 403 });
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в аккаунт' });
  next();
}

/** Своё «я»: как publicUser, плюс флаг модератора — его видит только сам человек. */
export const selfUser = (row) => (row.moderator ? { ...publicUser(row), moderator: true } : publicUser(row));

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio ?? '',
    avatarUrl: publicUrl('avatar', row.avatar_path),
    createdAt: row.created_at,
  };
}
