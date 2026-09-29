import { type Author, type Person } from '../../api';
import { type DbUser, db, fail } from '../store';

/** Люди глазами смотрящего: кто вошёл, блокировки, «в сети» с учётом настройки. */

export const byId = (userId: number) => db.users.find((u) => u.id === userId);

export const byName = (username: string) => db.users.find((u) => u.username === username.toLowerCase());

export const byEmail = (mail: string) => db.users.find((u) => u.email === mail.toLowerCase());

export const me = () => (db.meId != null ? byId(db.meId) ?? null : null);

export const requireMe = () => me() ?? fail(401, 'Требуется вход в аккаунт');

export const author = (u: DbUser): Author => ({
  id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl,
});

/** Сам смотрящий в витрине всегда «сейчас» — отдельного учёта визитов здесь
 *  нет, и так он совпадает с тем, что делает loadUser на сервере. */
export const seenAt = (u: DbUser) =>
  u.alwaysOnline || u.id === db.meId ? new Date().toISOString() : u.lastSeenAt;

export const RECENT_MS = 3 * 864e5;

/** Показывает ли `owner` своё время человеку `otherId` — как shares() в presence.js. */
export const sharesSeen = (owner: DbUser, otherId: number) => {
  const privacy = owner.lastSeenPrivacy ?? 'all';
  if (privacy === 'nobody') return false;
  if (privacy === 'follows') return db.follows.some((f) => f.followerId === owner.id && f.followeeId === otherId);
  return true;
};

/** Человек в переписке. Время визита скрыто для пары в блокировке и
 *  настройкой — взаимно, как на сервере; спрятанное — «был(а) недавно». */
export const person = (u: DbUser): Person => {
  const seen = seenAt(u);
  if (db.meId == null || u.id === db.meId) return { ...author(u), lastSeenAt: seen };
  if (blockedPair(db.meId, u.id)) return { ...author(u), lastSeenAt: null, seenRecently: false };
  if (sharesSeen(u, db.meId) && sharesSeen(byId(db.meId)!, u.id)) return { ...author(u), lastSeenAt: seen, seenRecently: false };
  return { ...author(u), lastSeenAt: null, seenRecently: seen != null && Date.now() - Date.parse(seen) < RECENT_MS };
};

/**
 * Блокировка симметрична: достаточно одной стороны, чтобы двое перестали
 * видеть контент друг друга и потеряли возможность писать. Одно правило вместо
 * десяти частных — ровно как на сервере.
 */
export const blockedPair = (aId: number, bId: number) =>
  db.blocks.some((b) =>
    (b.blockerId === aId && b.blockedId === bId) || (b.blockerId === bId && b.blockedId === aId));

/** Скрыт ли автор от того, кто сейчас смотрит. Для гостя — никогда. */
export const hidden = (authorId: number) => db.meId != null && blockedPair(db.meId, authorId);

export const visiblePosts = () => db.posts.filter((p) => !hidden(p.authorId));
