import { db } from './db.js';

/**
 * Настройки чатов в списке: закреплён ли чат и выключены ли уведомления.
 * У каждого человека свои. Правила, которые из этого следуют, собраны здесь:
 * приглушённый чат не попадает в общие счётчики и не создаёт событий, но его
 * собственное «непрочитанное» по-прежнему считается — в списке оно серое.
 */

/** Столько чатов можно закрепить — как у Телеграма без подписки. */
export const PIN_LIMIT = 5;
export const PREF_KINDS = ['dm', 'chat', 'channel'];

/** Настройки человека для всех чатов одного вида: target_id → {pinnedAt, muted}. */
export function prefsOf(userId, kind) {
  const rows = db.prepare('SELECT target_id, pinned_at, muted FROM chat_prefs WHERE user_id = ? AND kind = ?')
    .all(userId, kind);
  return new Map(rows.map((r) => [r.target_id, { pinnedAt: r.pinned_at ?? null, muted: Boolean(r.muted) }]));
}

const NO_PREFS = { pinnedAt: null, muted: false };
export const prefFor = (map, targetId) => map.get(targetId) ?? NO_PREFS;

export function isMuted(userId, kind, targetId) {
  if (targetId == null) return false;
  return Boolean(
    db.prepare('SELECT 1 FROM chat_prefs WHERE user_id = ? AND kind = ? AND target_id = ? AND muted = 1')
      .get(userId, kind, targetId),
  );
}

/**
 * SQL-условие «чат не приглушён» для подсчёта непрочитанного. Имена колонок
 * подставляются текстом — только из кода, не из запроса.
 */
export const notMutedSql = (kind, userColumn, targetColumn) => `NOT EXISTS (
  SELECT 1 FROM chat_prefs cp
  WHERE cp.user_id = ${userColumn} AND cp.kind = '${kind}' AND cp.target_id = ${targetColumn} AND cp.muted = 1
)`;

/** Непрочитанные ЛС для общего счётчика — без приглушённых собеседников. */
export function dmUnreadTotal(userId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM messages m
    WHERE m.to_id = ? AND m.read_at IS NULL AND ${notMutedSql('dm', 'm.to_id', 'm.from_id')}
  `).get(userId).c;
}

/**
 * Выставляет настройки. `pinned`/`muted` — true, false или undefined (не
 * трогать). Когда обе выключены, строка удаляется: «ничего не настроено» не
 * должно занимать место. Лимит закреплённых проверяет вызывающий.
 */
export function setPrefs(userId, kind, targetId, { pinned, muted }) {
  const current = db.prepare('SELECT pinned_at, muted FROM chat_prefs WHERE user_id = ? AND kind = ? AND target_id = ?')
    .get(userId, kind, targetId);

  // Время закрепления сохраняется при повторном «закрепить»: порядок
  // закреплённых — это порядок, в котором их закрепляли.
  const pinnedAt = pinned === undefined
    ? current?.pinned_at ?? null
    : pinned ? current?.pinned_at ?? new Date().toISOString() : null;
  const mutedNow = muted === undefined ? Boolean(current?.muted) : Boolean(muted);

  if (!pinnedAt && !mutedNow) {
    db.prepare('DELETE FROM chat_prefs WHERE user_id = ? AND kind = ? AND target_id = ?').run(userId, kind, targetId);
  } else {
    db.prepare(`
      INSERT INTO chat_prefs (user_id, kind, target_id, pinned_at, muted) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, kind, target_id) DO UPDATE SET pinned_at = excluded.pinned_at, muted = excluded.muted
    `).run(userId, kind, targetId, pinnedAt, mutedNow ? 1 : 0);
  }
  return { pinnedAt, muted: mutedNow };
}

export const pinnedCount = (userId) =>
  db.prepare('SELECT COUNT(*) AS c FROM chat_prefs WHERE user_id = ? AND pinned_at IS NOT NULL').get(userId).c;

/**
 * Человек потерял доступ к чату или каналу — его настройки там больше не
 * нужны, как и сам чат в его папках. Без `userId` — чата больше нет ни у кого.
 */
export function dropPrefs({ userId = null, kind, targetId }) {
  if (userId == null) {
    db.prepare('DELETE FROM chat_prefs WHERE kind = ? AND target_id = ?').run(kind, targetId);
    db.prepare('DELETE FROM chat_folder_items WHERE kind = ? AND target_id = ?').run(kind, targetId);
  } else {
    db.prepare('DELETE FROM chat_prefs WHERE user_id = ? AND kind = ? AND target_id = ?').run(userId, kind, targetId);
    db.prepare(`
      DELETE FROM chat_folder_items
      WHERE kind = ? AND target_id = ? AND folder_id IN (SELECT id FROM chat_folders WHERE user_id = ?)
    `).run(kind, targetId, userId);
  }
}
