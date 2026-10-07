import { db, nowIso } from './db.js';

/**
 * Черновики — недописанный текст в поле ввода, у каждого чата свой. Живут на
 * сервере, как в Телеграме: начатое на телефоне продолжается на компьютере, а
 * в списке чатов видно «Черновик: …». Видит их только автор.
 *
 * Вид и цель — как у настроек чатов (prefs.js): dm — собеседник, chat —
 * группа, channel — свой канал. Внешнего ключа на цель нет (она в трёх разных
 * таблицах), поэтому удаление чата, канала или аккаунта убирает черновики
 * руками — dropDrafts().
 */

export const DRAFT_KINDS = ['dm', 'chat', 'channel'];

/** Потолок черновика — как у того, во что он превратится. */
export const DRAFT_MAX = { dm: 1000, chat: 1000, channel: 4000 };

const serialize = (row) => (row ? { body: row.body, updatedAt: row.updated_at } : null);

/** Все черновики человека одного вида: target_id → {body, updatedAt}. Для списков чатов. */
export function draftsOf(userId, kind) {
  const rows = db.prepare('SELECT target_id, body, updated_at FROM drafts WHERE user_id = ? AND kind = ?').all(userId, kind);
  return new Map(rows.map((r) => [r.target_id, serialize(r)]));
}

export function draftFor(userId, kind, targetId) {
  return serialize(
    db.prepare('SELECT body, updated_at FROM drafts WHERE user_id = ? AND kind = ? AND target_id = ?').get(userId, kind, targetId),
  );
}

/** Сохранить; пустой (или из одних пробелов) — значит, черновика больше нет. */
export function saveDraft(userId, kind, targetId, body) {
  if (!body.trim()) {
    clearDraft(userId, kind, targetId);
    return null;
  }
  db.prepare(`
    INSERT INTO drafts (user_id, kind, target_id, body, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, kind, target_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
  `).run(userId, kind, targetId, body, nowIso());
  return draftFor(userId, kind, targetId);
}

export function clearDraft(userId, kind, targetId) {
  db.prepare('DELETE FROM drafts WHERE user_id = ? AND kind = ? AND target_id = ?').run(userId, kind, targetId);
}

/** Цель исчезла (чат, канал, собеседник удалены) — черновики к ней больше некуда отправить. */
export function dropDrafts(kind, targetId) {
  db.prepare('DELETE FROM drafts WHERE kind = ? AND target_id = ?').run(kind, targetId);
}

/* ─ Черновик записи ленты ────────────────────────────────────────────────
 * Один на человека: поле «Что вы хотите записать?» продолжается на другом
 * устройстве. Уходит, когда запись опубликована из композера или отложена —
 * цитата пишется в своём окне, её текст черновиком не был.
 */
export const POST_DRAFT_MAX = 500;

export function postDraftOf(userId) {
  return serialize(db.prepare('SELECT body, updated_at FROM post_drafts WHERE user_id = ?').get(userId));
}

export function savePostDraft(userId, body) {
  if (!body.trim()) {
    clearPostDraft(userId);
    return null;
  }
  db.prepare(`
    INSERT INTO post_drafts (user_id, body, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
  `).run(userId, body, nowIso());
  return postDraftOf(userId);
}

export function clearPostDraft(userId) {
  db.prepare('DELETE FROM post_drafts WHERE user_id = ?').run(userId);
}
