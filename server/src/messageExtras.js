import multer from 'multer';
import { db } from './db.js';
import { blockPairSql } from './blocks.js';
import { copyUpload, deleteUpload, fileName, storeUpload } from './media.js';
import { HttpError, bad, str } from './validate.js';

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
  channel: { messages: 'channel_posts', reactions: 'channel_post_reactions', author: 'author_id' },
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
    SELECT m.id, m.body, m.attach_kind, m.attach_name, u.id AS author_id, u.display_name
    FROM ${TABLES[kind].messages} m JOIN users u ON u.id = m.${TABLES[kind].author}
    WHERE m.id IN (${inList(ids, params)}) AND ${scope}
  `).all(params);

  for (const row of rows) {
    // Ответ на фото без подписи цитирует не пустоту, а «Фото».
    const text = row.body || attachmentLabel(row.attach_kind, row.attach_name);
    out.set(row.id, {
      id: row.id,
      author: { id: row.author_id, displayName: row.display_name },
      body: text.length > QUOTE_LEN ? `${text.slice(0, QUOTE_LEN).trimEnd()}…` : text,
      attachmentKind: row.attach_kind ?? null,
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
  // «Переслано от человека» или «переслано из канала» — подпись ведёт туда,
  // откуда слова на самом деле. Удалили канал или ушёл человек — подписи нет.
  forwardedFrom: row.fwd_channel_handle
    ? { kind: 'channel', handle: row.fwd_channel_handle, title: row.fwd_channel_title }
    : row.fwd_username
      ? { kind: 'user', username: row.fwd_username, displayName: row.fwd_display_name }
      : null,
  replyToId: row.reply_to_id ?? null,
});

/** Колонки и JOIN источника пересылки для выборки с `extraFields`. */
export const FWD_COLUMNS =
  'f.username AS fwd_username, f.display_name AS fwd_display_name, fc.handle AS fwd_channel_handle, fc.title AS fwd_channel_title';
export const fwdJoin = (alias) =>
  `LEFT JOIN users f ON f.id = ${alias}.fwd_user_id LEFT JOIN channels fc ON fc.id = ${alias}.fwd_channel_id`;

/** Пересланное не правится: это чужие слова — человека или канала. */
export const isForwarded = (row) => row.fwd_user_id != null || row.fwd_channel_id != null;

/* ─ Вложения ───────────────────────────────────────────────────────────── */

/** Файл в памяти до проверки сигнатуры: на диск попадает только то, что
 *  опознано по содержимому. Потолок — как у записей в ленте. */
export const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
});

/** Голосовое — до пяти минут, как запись в браузере и рассчитана. */
export const VOICE_MAX_S = 300;
/** «Кружок» — до минуты, как в Телеграме: это реплика, а не ролик. */
export const VIDEO_NOTE_MAX_S = 60;

/** Колонки вложения для выборок с явным списком полей. */
export const ATTACH_COLUMNS =
  'm.attach_path, m.attach_kind, m.attach_mime, m.attach_name, m.attach_size, m.attach_duration, m.attach_wave';

/**
 * Вложение в ответе API. Ссылка ведёт не в /uploads, а на /api/attachments:
 * файл отдаётся только тому, кто видит само сообщение.
 */
export function attachmentOf(kind, row) {
  if (!row.attach_path) return null;
  return {
    url: `/api/attachments/${kind}/${row.id}`,
    kind: row.attach_kind,
    mime: row.attach_mime,
    name: row.attach_name ?? null,
    size: row.attach_size ?? null,
    duration: row.attach_duration ?? null,
    wave: row.attach_wave ?? null,
  };
}

/** Подпись вложения там, где его самого не видно: цитата, превью в списке. */
export function attachmentLabel(kind, name) {
  switch (kind) {
    case 'image': return 'Фото';
    case 'video': return 'Видео';
    case 'voice': return 'Голосовое сообщение';
    case 'videonote': return 'Видеосообщение';
    case 'audio': return name || 'Аудио';
    case 'file': return name || 'Файл';
    default: return '';
  }
}

/**
 * Принимает вложение из multipart-запроса и кладёт его в закрытый каталог.
 * Тип решает содержимое, а не имя и не заявленный MIME. Поля голосового
 * проверяются ДО записи на диск: иначе отказ оставил бы файл-сироту.
 */
export async function readAttachment(file, fields = {}) {
  if (!file) return null;

  const voice = fields.voice === '1' || fields.voice === 'true';
  // «Кружок» — видеосообщение с фронтальной камеры, как в Телеграме: до минуты.
  const videoNote = fields.videonote === '1' || fields.videonote === 'true';
  if (voice && videoNote) throw bad('Сообщение — либо голосовое, либо видео, не оба сразу');
  let duration = null;
  let wave = null;
  if (videoNote) {
    duration = Number(fields.duration);
    if (!Number.isInteger(duration) || duration < 1 || duration > VIDEO_NOTE_MAX_S) {
      throw bad(`Длительность видеосообщения — от 1 до ${VIDEO_NOTE_MAX_S} секунд`);
    }
  }
  if (voice) {
    duration = Number(fields.duration);
    if (!Number.isInteger(duration) || duration < 1 || duration > VOICE_MAX_S) {
      throw bad(`Длительность голосового — от 1 до ${VOICE_MAX_S} секунд`);
    }
    // «Волна» — до 64 столбиков высотой 0–9, строкой цифр: столько, сколько
    // нужно нарисовать, и ничего, что можно было бы вставить в чужой интерфейс.
    wave = fields.wave ? String(fields.wave) : null;
    if (wave != null && !/^[0-9]{1,64}$/.test(wave)) throw bad('Некорректная форма голосового');
  }

  // У записанного в браузере нет осмысленного имени файла — только у выбранного.
  const recorded = voice || videoNote;
  const name = recorded ? null : str(fileName(file.originalname), 'имя файла', { max: 200 }) || null;

  // Голосовое записывает браузер: Chrome и Firefox — в WebM или Ogg, Safari —
  // в MP4. Контейнер WebM и MP4 по сигнатуре — «видео», поэтому для голосового
  // допустимы и они, а тип переписывается на audio/*. «Кружок» — только видео.
  const stored = await storeUpload(file.buffer, {
    allowedKinds: videoNote ? ['video'] : voice ? ['audio', 'video'] : ['image', 'video', 'audio', 'file'],
    into: 'attachment',
  });

  return {
    path: stored.filename,
    kind: videoNote ? 'videonote' : voice ? 'voice' : stored.kind,
    mime: voice ? stored.mime.replace(/^video\//, 'audio/') : stored.mime,
    name,
    size: file.size,
    duration,
    wave,
  };
}

/** Пересылка вложения — копия файла: оригинал могут удалить, пересланное остаётся. */
export async function copyAttachment(att) {
  if (!att) return null;
  return { ...att, path: await copyUpload('attachment', att.path) };
}

/** Порядок значений для INSERT (…, attach_path, …, attach_wave). */
export const attachmentValues = (att) => [
  att?.path ?? null, att?.kind ?? null, att?.mime ?? null, att?.name ?? null,
  att?.size ?? null, att?.duration ?? null, att?.wave ?? null,
];

export const ATTACH_INSERT_COLUMNS =
  'attach_path, attach_kind, attach_mime, attach_name, attach_size, attach_duration, attach_wave';

/** Файл удалённого сообщения удаляется вместе с ним — вложение без сообщения никому не нужно. */
export const dropAttachment = (path) => deleteUpload('attachment', path);

/** Вложение из строки сообщения — в той форме, что нужна для копии. */
const attachmentFromRow = (row) =>
  row.attach_path
    ? {
        path: row.attach_path, kind: row.attach_kind, mime: row.attach_mime, name: row.attach_name,
        size: row.attach_size, duration: row.attach_duration, wave: row.attach_wave,
      }
    : null;

/* ─ Поиск внутри переписки ─────────────────────────────────────────────
 * Ищется только своя переписка — то, что человек и так видит, листая вверх.
 * Правила те же, что у поиска по записям: свёртка ё → е, регистр не важен,
 * все слова запроса должны встретиться. Фильтр на JS, а не LIKE: SQLite
 * сравнивает без учёта регистра только латиницу. Переписка одного человека —
 * тысячи строк, не миллионы; FTS-индекс здесь понадобится, когда станет иначе.
 */
const SEARCH_LIMIT = 50;
const foldText = (s) => String(s ?? '').replace(/ё/g, 'е').replace(/Ё/g, 'Е').toLowerCase();

export function searchQuery(raw) {
  const q = String(raw ?? '').trim();
  if (q.length > 100) throw bad('Запрос длиннее 100 символов');
  return foldText(q).split(/[^\p{L}\p{N}_]+/u).filter(Boolean).slice(0, 8);
}

/** Строки, где встретились все слова, — свежие сверху, не больше пятидесяти.
 *  Ищется и в имени файла: «договор» находит «Договор аренды.pdf». */
export function searchRows(rows, terms) {
  if (terms.length === 0) return [];
  const out = [];
  for (const row of rows) {
    const text = foldText(`${row.body} ${row.attach_name ?? ''}`);
    if (terms.every((t) => text.includes(t))) out.push(row);
    if (out.length >= SEARCH_LIMIT) break;
  }
  return out;
}

export const searchResult = (row, author = null) => ({
  id: row.id,
  body: row.body || attachmentLabel(row.attach_kind, row.attach_name),
  createdAt: row.created_at,
  author,
});

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
 * Публикацию канала переслать может любой: канал открыт всем. Чужое и
 * несуществующее неразличимы (404), как везде в проекте. Пересылка
 * пересланного указывает на первоисточник — человека или канал, как в Телеграме.
 */
export function forwardSource(input, viewerId) {
  if (input == null) return null;
  const id = Number(input.id);
  if (!['dm', 'chat', 'channel'].includes(input.from) || !Number.isSafeInteger(id) || id <= 0) {
    throw bad('Некорректная пересылка');
  }

  const sql = {
    dm: `
      SELECT m.body, m.from_id AS author, m.fwd_user_id, m.fwd_channel_id, ${ATTACH_COLUMNS} FROM messages m
      WHERE m.id = :id AND (m.from_id = :viewerId OR m.to_id = :viewerId)`,
    chat: `
      SELECT m.body, m.author_id AS author, m.fwd_user_id, m.fwd_channel_id, ${ATTACH_COLUMNS} FROM chat_messages m
      JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = :viewerId
      WHERE m.id = :id AND ${blockPairSql('m.author_id')}`,
    // Автор публикации — канал, а не человек: подпись будет «из канала».
    channel: `
      SELECT m.body, NULL AS author, NULL AS fwd_user_id, m.channel_id AS fwd_channel_id, ${ATTACH_COLUMNS}
      FROM channel_posts m WHERE m.id = :id`,
  }[input.from];

  // node:sqlite не прощает лишних именованных параметров, а публикации канала
  // смотрящий не нужен: канал открыт всем, кто вошёл.
  const row = db.prepare(sql).get(input.from === 'channel' ? { id } : { id, viewerId });
  if (!row) throw new HttpError(404, 'Сообщение для пересылки не найдено');

  const fromChannel = row.fwd_channel_id != null;
  return {
    body: row.body,
    fwdUserId: fromChannel ? null : row.fwd_user_id ?? row.author,
    fwdChannelId: fromChannel ? row.fwd_channel_id : null,
    attachment: attachmentFromRow(row),
  };
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
