import { db, nowIso } from './db.js';
import { contentLabel } from './messageExtras.js';

/**
 * Закреплённое сообщение — одно на переписку. Кто вправе закреплять, решает
 * роутер (в ЛС — любой из двоих, в группе и канале — владелец); здесь —
 * хранение и то, как закреплённое выглядит в ответе.
 */

/** Ключ переписки: у пары ЛС он одинаков с обеих сторон. */
export const dmScope = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;

export function pinnedId(kind, scopeId) {
  return db.prepare('SELECT message_id FROM pinned_messages WHERE kind = ? AND scope_id = ?')
    .get(kind, String(scopeId))?.message_id ?? null;
}

export function pin(kind, scopeId, messageId, userId) {
  db.prepare(`
    INSERT INTO pinned_messages (kind, scope_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (kind, scope_id) DO UPDATE SET
      message_id = excluded.message_id, pinned_by = excluded.pinned_by, pinned_at = excluded.pinned_at
  `).run(kind, String(scopeId), messageId, userId, nowIso());
}

export function unpin(kind, scopeId) {
  db.prepare('DELETE FROM pinned_messages WHERE kind = ? AND scope_id = ?').run(kind, String(scopeId));
}

/** Сообщение удалили — если оно было закреплено, закрепление снимается. */
export function unpinIfPinned(kind, scopeId, messageId) {
  db.prepare('DELETE FROM pinned_messages WHERE kind = ? AND scope_id = ? AND message_id = ?')
    .run(kind, String(scopeId), messageId);
}

/**
 * Закреплённое для ответа: `lookup(id)` ищет сообщение глазами смотрящего
 * (пара, чат с блокировками, канал). Не нашлось — для этого человека его нет:
 * полосы не будет. Удалённое снимается при удалении, сюда оно не доходит.
 */
export function pinnedPreview(kind, scopeId, lookup) {
  const id = pinnedId(kind, scopeId);
  if (id == null) return null;
  const row = lookup(id);
  if (!row) return null;
  return {
    id,
    body: contentLabel(row),
    attachmentKind: row.attach_kind ?? null,
  };
}
