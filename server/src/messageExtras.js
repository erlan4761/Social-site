import { db } from './db.js';
import { blockPairSql } from './blocks.js';
import { HttpError, bad } from './validate.js';

/**
 * Действия с сообщениями, общие для личной переписки и групповых чатов:
 * ответ с цитатой, правка, пересылка, реакции, «печатает…». Хранятся они в
 * двух парах таблиц (см. «Групповые чаты» в README), а правила у них одни —
 * поэтому правила живут здесь, а роутеры только подставляют свою таблицу.
 */

/** Набор реакций фиксирован: произвольный эмодзи из тела запроса — это
 *  произвольная строка в базе и в чужом интерфейсе. */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

/** Править можно двое суток, как в Телеграме: переписать разговор задним
 *  числом через месяц — уже не правка, а подмена. */
export const EDIT_WINDOW_MS = 48 * 60 * 60_000;

/** Цитата в ответе — начало сообщения, а не всё оно целиком. */
const QUOTE_LEN = 120;

const TABLES = {
  dm: { messages: 'messages', reactions: 'message_reactions', author: 'from_id' },
  chat: { messages: 'chat_messages', reactions: 'chat_message_reactions', author: 'author_id' },
};

/** `IN (…)` из списка id: именованные параметры, ни одного числа в тексте SQL. */
function inList(ids, params) {
  return ids
    .map((id, i) => {
      params[`id${i}`] = id;
      return `:id${i}`;
    })
    .join(', ');
}

/**
 * Реакции страницы сообщений одним запросом: `{emoji, count, mine}` на каждое.
 * Реакции тех, с кем смотрящий в блокировке, не считаются — блокировка прячет
 * всё, что человек оставил, и счётчик не исключение.
 */
export function reactionsFor(kind, ids, viewerId) {
  const out = new Map();
  if (ids.length === 0) return out;

  const params = { viewerId };
  const rows = db.prepare(`
    SELECT r.message_id AS mid, r.emoji, COUNT(*) AS n,
           MAX(r.user_id = :viewerId) AS mine, MIN(r.created_at) AS first
    FROM ${TABLES[kind].reactions} r
    WHERE r.message_id IN (${inList(ids, params)}) AND ${blockPairSql('r.user_id')}
    GROUP BY r.message_id, r.emoji
    ORDER BY first
  `).all(params);

  for (const row of rows) {
    if (!out.has(row.mid)) out.set(row.mid, []);
    out.get(row.mid).push({ emoji: row.emoji, count: row.n, mine: Boolean(row.mine) });
  }
  return out;
}

/**
 * Цитаты для ответов. `scope` — SQL-условие «то же пространство переписки»
 * (пара в ЛС, тот же чат). Чего нет в этом пространстве — удалено, скрыто
 * блокировкой или никогда там не было — приходит как `{id, deleted: true}`:
 * для читающего это одно и то же «сообщение недоступно».
 */
export function quotesFor(kind, replyIds, scope, scopeParams) {
  const out = new Map();
  const ids = [...new Set(replyIds.filter((id) => id != null))];
  if (ids.length === 0) return out;

  const params = { ...scopeParams };
  const rows = db.prepare(`
    SELECT m.id, m.body, u.id AS author_id, u.display_name
    FROM ${TABLES[kind].messages} m JOIN users u ON u.id = m.${TABLES[kind].author}
    WHERE m.id IN (${inList(ids, params)}) AND ${scope}
  `).all(params);

  for (const row of rows) {
    out.set(row.id, {
      id: row.id,
      author: { id: row.author_id, displayName: row.display_name },
      body: row.body.length > QUOTE_LEN ? `${row.body.slice(0, QUOTE_LEN).trimEnd()}…` : row.body,
    });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { id, deleted: true });
  return out;
}

/** Дополняет сериализованные сообщения цитатами и реакциями — двумя запросами на страницу. */
export function decorate(kind, messages, { viewerId, scope, scopeParams }) {
  const quotes = quotesFor(kind, messages.map((m) => m.replyToId), scope, scopeParams);
  const reactions = reactionsFor(kind, messages.map((m) => m.id), viewerId);
  return messages.map(({ replyToId, ...m }) => ({
    ...m,
    replyTo: replyToId == null ? null : quotes.get(replyToId),
    reactions: reactions.get(m.id) ?? [],
  }));
}

/** Общие поля сообщения из строки с `reply_to_id`, `edited_at` и `fwd_*`. */
export const extraFields = (row) => ({
  editedAt: row.edited_at ?? null,
  forwardedFrom: row.fwd_username
    ? { username: row.fwd_username, displayName: row.fwd_display_name }
    : null,
  replyToId: row.reply_to_id ?? null,
});

/** Колонки и JOIN автора оригинала для выборки с `extraFields`. */
export const FWD_COLUMNS = 'f.username AS fwd_username, f.display_name AS fwd_display_name';
export const fwdJoin = (alias) => `LEFT JOIN users f ON f.id = ${alias}.fwd_user_id`;

/* ─ Проверки ввода ─────────────────────────────────────────────────────── */

/** `replyTo` из тела запроса: число или отсутствие. Есть ли такое сообщение
 *  в этой переписке, проверяет роутер — только он знает её границы. */
export function replyIdOf(value) {
  if (value == null) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw bad('Некорректный ответ на сообщение');
  return id;
}

export function emojiOf(value) {
  if (!REACTIONS.includes(value)) throw bad('Такой реакции нет');
  return value;
}

/** Можно ли править: только своё и только в первые двое суток. */
export function assertEditable(authorId, createdAt, viewerId) {
  if (authorId !== viewerId) throw new HttpError(403, 'Изменить можно только своё сообщение');
  if (Date.now() - Date.parse(createdAt) > EDIT_WINDOW_MS) {
    throw new HttpError(403, 'Сообщение можно изменить только в течение 48 часов');
  }
}

/**
 * Что пересылается. Источник проверяется глазами пересылающего: из ЛС — только
 * из своей пары, из чата — только где он участник и не от заблокированного.
 * Чужое и несуществующее неразличимы (404), как везде в проекте. Пересылка
 * пересланного указывает на первоисточник — так делает и Телеграм.
 */
export function forwardSource(input, viewerId) {
  if (input == null) return null;
  const id = Number(input.id);
  if (!['dm', 'chat'].includes(input.from) || !Number.isSafeInteger(id) || id <= 0) {
    throw bad('Некорректная пересылка');
  }

  const row =
    input.from === 'dm'
      ? db.prepare(`
          SELECT body, from_id AS author, fwd_user_id FROM messages
          WHERE id = :id AND (from_id = :viewerId OR to_id = :viewerId)
        `).get({ id, viewerId })
      : db.prepare(`
          SELECT m.body, m.author_id AS author, m.fwd_user_id FROM chat_messages m
          JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = :viewerId
          WHERE m.id = :id AND ${blockPairSql('m.author_id')}
        `).get({ id, viewerId });

  if (!row) throw new HttpError(404, 'Сообщение для пересылки не найдено');
  return { body: row.body, fwdUserId: row.fwd_user_id ?? row.author };
}

/* ─ «Печатает…» ─────────────────────────────────────────────────────────
 * Живёт в памяти процесса, а не в базе: это сигнал на несколько секунд, и
 * писать его на диск ради того, чтобы через шесть секунд стереть, незачем.
 * Цена — один процесс; при нескольких инстансах сюда понадобится общий стор,
 * как и лимитеру (см. README, «Чего осознанно нет»).
 */
const TYPING_TTL_MS = 6_000;
const typing = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, until] of typing) if (until <= now) typing.delete(key);
}, 30_000).unref();

/** Ключ переписки: у пары ЛС он одинаков с обеих сторон. */
export const dmKey = (a, b) => `dm:${Math.min(a, b)}-${Math.max(a, b)}`;
export const chatKey = (chatId) => `chat:${chatId}`;

export function setTyping(key, userId) {
  typing.set(`${key}|${userId}`, Date.now() + TYPING_TTL_MS);
}

/** Отправил — значит, уже не печатает: иначе «печатает…» висело бы ещё шесть
 *  секунд после того, как сообщение пришло. */
export function clearTyping(key, userId) {
  typing.delete(`${key}|${userId}`);
}

export function isTyping(key, userId) {
  return (typing.get(`${key}|${userId}`) ?? 0) > Date.now();
}
