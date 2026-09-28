import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, nowIso } from './db.js';
import { publicUrl } from './media.js';

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'sid';

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

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, nowIso(), expires.toISOString());
  return { token, expires };
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
export function loadUser(req, _res, next) {
  req.user = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.bio, u.avatar_path, u.created_at, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);

    if (row && new Date(row.expires_at) > new Date()) {
      req.user = publicUser(row);
      req.sessionToken = token;
      touchLastSeen(row.id);
    } else if (row) {
      destroySession(token);
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в аккаунт' });
  next();
}

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
