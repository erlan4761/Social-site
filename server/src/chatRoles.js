import { db } from './db.js';

/**
 * Роли в группе, как у Телеграма, только проще — без галочек на каждое право:
 *
 *   владелец — всё, в том числе назначать администраторов и удалять группу;
 *   администратор — порядок: убирать обычных участников и их сообщения,
 *                   закреплять, менять название и настройки, ссылку-приглашение;
 *   участник — писать (если группа это разрешает) и звать людей.
 *
 * Две настройки группы действуют только на обычных участников:
 *   медленный режим — одно сообщение в N секунд;
 *   «пишут только администраторы» — группа превращается в объявления,
 *   реакции остаются всем.
 */

/** Медленный режим: 0 — выключен. Те же ступени, что в Телеграме. */
export const SLOW_MODE_OPTIONS = [0, 10, 30, 60, 300, 900, 3600];

/** 'owner' | 'admin' | 'member' | null (не участник). `chat` — строка chats. */
export function roleOf(chat, userId) {
  if (chat.owner_id === userId) return 'owner';
  const row = db.prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chat.id, userId);
  if (!row) return null;
  return row.role === 'admin' ? 'admin' : 'member';
}

export const isAdmin = (chat, userId) => ['owner', 'admin'].includes(roleOf(chat, userId));

/**
 * Может ли `actorId` убрать `targetId` (из группы или его сообщение): владелец —
 * любого, администратор — только обычного участника. Иначе два администратора
 * могли бы выгнать друг друга, а заодно и владельца.
 */
export function outranks(chat, actorId, targetId) {
  const actor = roleOf(chat, actorId);
  if (actor === 'owner') return targetId !== actorId;
  return actor === 'admin' && roleOf(chat, targetId) === 'member';
}

/**
 * Кто унаследует группу, когда владелец уходит: старейший администратор, а
 * если их нет — старейший участник. null — больше никого не осталось.
 */
export function heirOf(chatId, leavingId) {
  return db.prepare(`
    SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id <> ?
    ORDER BY role = 'admin' DESC, joined_at, user_id LIMIT 1
  `).get(chatId, leavingId)?.user_id ?? null;
}

const lastPostAt = (chatId, userId) =>
  db.prepare('SELECT MAX(created_at) AS at FROM chat_messages WHERE chat_id = ? AND author_id = ?').get(chatId, userId)?.at ?? null;

/**
 * Когда обычному участнику можно написать снова (ISO) — или null, если уже
 * можно. Администраторов медленный режим не касается.
 */
export function nextPostAt(chat, userId, now = Date.now()) {
  if (!chat.slow_mode || isAdmin(chat, userId)) return null;
  const last = lastPostAt(chat.id, userId);
  if (!last) return null;
  const next = Date.parse(last) + chat.slow_mode * 1000;
  return next > now ? new Date(next).toISOString() : null;
}

const waitText = (seconds) => {
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} мин`;
};

/**
 * Почему этому человеку сейчас нельзя написать в группу — или null. Ответ
 * готов для клиента: статус, текст и, для медленного режима, через сколько.
 */
export function postBlock(chat, userId, { ignoreSlowMode = false } = {}) {
  if (isAdmin(chat, userId)) return null;
  if (chat.admins_only) return { status: 403, error: 'Писать в эту группу могут только администраторы' };
  const next = ignoreSlowMode ? null : nextPostAt(chat, userId);
  if (next) {
    const retryAfter = Math.max(1, Math.ceil((Date.parse(next) - Date.now()) / 1000));
    return { status: 429, error: `Медленный режим: следующее сообщение — через ${waitText(retryAfter)}`, retryAfter };
  }
  return null;
}
