import { db, nowIso } from './db.js';
import { contentLabel } from './messageExtras.js';
import { bad } from './validate.js';

/**
 * Закреплённые сообщения — несколько на переписку, как в Телеграме: полоса
 * под шапкой показывает последнее и по нажатию перебирает остальные. Кто
 * вправе закреплять, решает роутер (в ЛС — любой из двоих, в группе —
 * владелец и администраторы, в канале — владелец); здесь — хранение и то, как
 * закреплённое выглядит в ответе.
 */

/** Больше двадцати — это уже не «главное», а вторая лента. */
export const PINS_MAX = 20;

/** Ключ переписки: у пары ЛС он одинаков с обеих сторон. */
export const dmScope = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;

/** Закреплённые — свежие по сообщению сверху. */
export const pinnedIds = (kind, scopeId) =>
  db.prepare('SELECT message_id FROM pinned_messages WHERE kind = ? AND scope_id = ? ORDER BY message_id DESC')
    .all(kind, String(scopeId)).map((r) => r.message_id);

/** Закрепить ещё одно; уже закреплённое — просто обновляет, кто и когда. */
export function pin(kind, scopeId, messageId, userId) {
  const ids = pinnedIds(kind, scopeId);
  if (!ids.includes(messageId) && ids.length >= PINS_MAX) {
    throw bad(`Закреплено уже ${PINS_MAX} — открепите что-нибудь`);
  }
  db.prepare(`
    INSERT INTO pinned_messages (kind, scope_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (kind, scope_id, message_id) DO UPDATE SET pinned_by = excluded.pinned_by, pinned_at = excluded.pinned_at
  `).run(kind, String(scopeId), messageId, userId, nowIso());
}

/** Открепить одно (`messageId`) или все закреплённые переписки. */
export function unpin(kind, scopeId, messageId = null) {
  if (messageId == null) {
    db.prepare('DELETE FROM pinned_messages WHERE kind = ? AND scope_id = ?').run(kind, String(scopeId));
  } else {
    db.prepare('DELETE FROM pinned_messages WHERE kind = ? AND scope_id = ? AND message_id = ?')
      .run(kind, String(scopeId), messageId);
  }
}

/** Сообщение удалили — если оно было закреплено, закрепление снимается. */
export const unpinIfPinned = (kind, scopeId, messageId) => unpin(kind, scopeId, messageId);

/**
 * Закреплённые для ответа: `lookup(id)` ищет сообщение глазами смотрящего
 * (пара, чат с блокировками, канал). Не нашлось — для этого человека его нет.
 * Удалённое снимается при удалении, сюда оно не доходит.
 */
export function pinnedList(kind, scopeId, lookup) {
  const out = [];
  for (const id of pinnedIds(kind, scopeId)) {
    const row = lookup(id);
    if (row) out.push({ id, body: contentLabel(row), attachmentKind: row.attach_kind ?? null });
  }
  return out;
}

/** Последнее закреплённое — поле `pinned` старых ответов, рядом со списком `pins`. */
export const pinnedPreview = (kind, scopeId, lookup) => pinnedList(kind, scopeId, lookup)[0] ?? null;

/** И последнее, и весь список — так отвечают все ручки закрепления. */
export function pinsPayload(kind, scopeId, lookup) {
  const pins = pinnedList(kind, scopeId, lookup);
  return { pinned: pins[0] ?? null, pins };
}
