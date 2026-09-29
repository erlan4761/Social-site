import { db, nowIso } from './db.js';

/**
 * Логин можно сменить, как в Телеграме. Старый при этом не освобождается
 * сразу: HOLD_DAYS дней он закреплён за прежним владельцем. Иначе любой мог бы
 * тут же занять его и получать сообщения, упоминания и переходы по старым
 * ссылкам, выдавая себя за другого. Владелец может вернуть свой старый логин,
 * пока он закреплён; остальным он в это время «занят».
 */
export const HOLD_DAYS = 14;

/** Занят ли логин для этого человека: чужой аккаунт или чужая бронь. */
export function usernameTaken(username, forUserId = null) {
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id IS NOT ?').get(username, forUserId)) return true;
  const hold = db.prepare('SELECT user_id FROM username_holds WHERE username = ? AND until > ?').get(username, nowIso());
  return Boolean(hold && hold.user_id !== forUserId);
}

/** Закрепить логин за человеком на HOLD_DAYS дней. Возвращает, до какого времени. */
export function holdUsername(username, userId) {
  const until = new Date(Date.now() + HOLD_DAYS * 864e5).toISOString();
  db.prepare(`
    INSERT INTO username_holds (username, user_id, until) VALUES (?, ?, ?)
    ON CONFLICT (username) DO UPDATE SET user_id = excluded.user_id, until = excluded.until
  `).run(username, userId, until);
  return until;
}

/** Сменить логин: старый — в бронь на HOLD_DAYS дней, своя бронь на новый снимается. */
export function changeUsername(userId, oldName, newName) {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newName, userId);
    db.prepare('DELETE FROM username_holds WHERE username = ?').run(newName);
    const until = holdUsername(oldName, userId);
    db.exec('COMMIT');
    return until;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
