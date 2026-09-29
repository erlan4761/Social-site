import { type Attachment, type AttachmentInput, type ConversationHit, type ForwardedFrom, type ForwardRef, type Message, type Quote, type Reaction } from '../../api';
import { STICKER_PACKS } from '../../stickers';
import { type DbUser, type DbExtras, type DbMessage, type DbReaction, NO_EXTRAS, db, typingUntil, id, fail } from '../store';
import { byId, byName, requireMe, blockedPair, hidden } from './people';
import { foldSearchText, wordsOf } from './posts';
import { notify } from './notifications';
import { memberRow } from './chats';
import { pollOf } from './polls';

/** Общее для ЛС и групп: цитаты, реакции, вложения, пересылка, «печатает…», стикеры, живая Марина. */

// ─ Действия с сообщениями: общее для ЛС и чатов ────────────────────────────

export const REACTION_SET: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

export const EDIT_WINDOW_MS = 48 * 60 * 60_000;

export const QUOTE_LEN = 120;

export const TYPING_TTL_MS = 6_000;

/** Реакции сообщения глазами смотрящего: заблокированные не считаются. */
export function reactionsOf(list: DbReaction[], messageId: number): Reaction[] {
  const out: Reaction[] = [];
  for (const r of list.filter((x) => x.messageId === messageId && !hidden(x.userId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const same = out.find((x) => x.emoji === r.emoji);
    if (same) {
      same.count += 1;
      same.mine ||= r.userId === db.meId;
    } else {
      out.push({ emoji: r.emoji, count: 1, mine: r.userId === db.meId });
    }
  }
  return out;
}

/** Цитата: чего нет среди видимых сообщений той же переписки — «удалено». */
export function quoteOf(
  replyToId: number | null,
  visible: { id: number; body: string; authorId: number; attachment: Attachment | null; sticker?: string | null }[],
): Quote | null {
  if (replyToId == null) return null;
  const m = visible.find((x) => x.id === replyToId);
  if (!m) return { id: replyToId, deleted: true };
  const a = byId(m.authorId)!;
  const text = m.body || (m.sticker ? 'Стикер' : attachmentLabelOf(m.attachment));
  return {
    id: m.id,
    author: { id: a.id, displayName: a.displayName },
    body: text.length > QUOTE_LEN ? `${text.slice(0, QUOTE_LEN).trimEnd()}…` : text,
    attachmentKind: m.attachment?.kind ?? null,
  };
}

/** То же, что attachmentLabel() на сервере. */
export function attachmentLabelOf(a: Attachment | null) {
  if (!a) return '';
  if (a.kind === 'image') return 'Фото';
  if (a.kind === 'video') return 'Видео';
  if (a.kind === 'voice') return 'Голосовое сообщение';
  if (a.kind === 'videonote') return 'Видеосообщение';
  if (a.kind === 'audio') return a.name || 'Аудио';
  return a.name || 'Файл';
}

/**
 * Вложение из выбранного файла. Настоящий сервер решает тип по первым байтам,
 * витрине хватает MIME из браузера: сюда никто, кроме смотрящего, ничего не
 * загружает, и бояться подмены некого.
 */
export function attachmentFrom(input: AttachmentInput): Attachment {
  if (input.file.size > 40 * 1024 * 1024) fail(413, 'Файл слишком большой');
  const type = input.file.type;
  const kind: Attachment['kind'] = input.videoNote
    ? 'videonote'
    : input.voice
    ? 'voice'
    : type.startsWith('image/') ? 'image'
    : type.startsWith('video/') ? 'video'
    : type.startsWith('audio/') ? 'audio'
    : 'file';
  if (input.videoNote && (input.videoNote.duration < 1 || input.videoNote.duration > 60)) {
    fail(400, 'Длительность видеосообщения — от 1 до 60 секунд');
  }
  if (input.voice && (input.voice.duration < 1 || input.voice.duration > 300)) {
    fail(400, 'Длительность голосового — от 1 до 300 секунд');
  }
  return {
    url: URL.createObjectURL(input.file),
    kind,
    mime: type || 'application/octet-stream',
    name: input.voice || input.videoNote ? null : input.name ?? null,
    size: input.file.size,
    duration: input.voice?.duration ?? input.videoNote?.duration ?? null,
    wave: input.voice?.wave ?? null,
  };
}

export const forwardedOf = (m: DbExtras): ForwardedFrom | null => {
  if (m.fwdChannelId != null) {
    const c = db.channels.find((x) => x.id === m.fwdChannelId);
    return c ? { kind: 'channel', handle: c.handle, title: c.title } : null;
  }
  const u = m.fwdUserId != null ? byId(m.fwdUserId) : undefined;
  return u ? { kind: 'user', username: u.username, displayName: u.displayName } : null;
};

export const pairOf = (m: DbMessage) =>
  db.messages.filter((x) => (x.fromId === m.fromId && x.toId === m.toId) || (x.fromId === m.toId && x.toId === m.fromId));

export const toMessage = (m: DbMessage): Message => ({
  id: m.id, body: m.body, createdAt: m.createdAt, fromId: m.fromId, toId: m.toId, readAt: m.readAt,
  editedAt: m.editedAt,
  forwardedFrom: forwardedOf(m),
  replyTo: quoteOf(m.replyToId, pairOf(m).map((x) => ({ id: x.id, body: x.body, authorId: x.fromId, attachment: x.attachment, sticker: x.sticker }))),
  reactions: reactionsOf(db.dmReactions, m.id),
  attachment: m.attachment,
  sticker: m.sticker ?? null,
});

/** Правка: своё, не пересланное, в первые двое суток — те же правила, что на сервере. */
export function assertEditable(authorId: number, createdAt: string, fwdUserId: number | null, u: DbUser, fwdChannelId: number | null = null) {
  if (authorId !== u.id) fail(403, 'Изменить можно только своё сообщение');
  if (Date.now() - Date.parse(createdAt) > EDIT_WINDOW_MS) fail(403, 'Сообщение можно изменить только в течение 48 часов');
  if (fwdUserId != null || fwdChannelId != null) fail(403, 'Пересланное сообщение изменить нельзя');
}

export function setReaction(list: DbReaction[], messageId: number, userId: number, emoji: string | null) {
  const at = list.findIndex((r) => r.messageId === messageId && r.userId === userId);
  if (at >= 0) list.splice(at, 1);
  if (emoji) {
    if (!REACTION_SET.includes(emoji)) fail(400, 'Такой реакции нет');
    list.push({ messageId, userId, emoji, createdAt: new Date().toISOString() });
  }
}

export const pairThread = (a: number, b: number) =>
  db.messages.filter((m) => (m.fromId === a && m.toId === b) || (m.fromId === b && m.toId === a));

/** Сообщение пары «я — собеседник» по id. Чужое и несуществующее — одно 404. */
export function requirePairMessage(username: string, messageId: number) {
  const u = requireMe()!;
  const other = byName(username);
  if (!other) fail(404, 'Пользователь не найден');
  const m = pairThread(u.id, other!.id).find((x) => x.id === messageId);
  if (!m) fail(404, 'Сообщение не найдено');
  return { u, other: other!, m: m! };
}

/**
 * Поиск по переписке — те же правила, что на сервере: ё → е, регистр не
 * важен, все слова должны встретиться, ищется и имя файла; свежие сверху.
 */
export function findHits<T extends { id: number; body: string; createdAt: string; attachment: Attachment | null }>(
  q: string,
  list: T[],
  authorOf: (m: T) => number | null,
): ConversationHit[] {
  if (q.trim().length > 100) fail(400, 'Запрос длиннее 100 символов');
  const terms = wordsOf(q).slice(0, 8);
  if (terms.length === 0) return [];
  return [...list]
    .sort((a, b) => b.id - a.id)
    .filter((m) => {
      const text = foldSearchText(`${m.body} ${m.attachment?.name ?? ''}`).toLowerCase();
      return terms.every((t) => text.includes(t));
    })
    .slice(0, 50)
    .map((m) => {
      const who = authorOf(m);
      const a = who != null ? byId(who) : undefined;
      return {
        id: m.id,
        body: m.body || attachmentLabelOf(m.attachment),
        createdAt: m.createdAt,
        author: a ? { id: a.id, displayName: a.displayName } : null,
      };
    });
}

export const dmKey = (a: number, b: number) => `dm:${Math.min(a, b)}-${Math.max(a, b)}`;

export const setTyping = (key: string, userId: number) => typingUntil.set(`${key}|${userId}`, Date.now() + TYPING_TTL_MS);

export const clearTyping = (key: string, userId: number) => typingUntil.delete(`${key}|${userId}`);

export const isTyping = (key: string, userId: number) => (typingUntil.get(`${key}|${userId}`) ?? 0) > Date.now();

/** Первоисточник: пересланное пересланного указывает туда же, куда оригинал. */
export const origin = (m: DbExtras & { body: string }, author: number) =>
  m.fwdChannelId != null
    ? { body: m.body, fwdUserId: null, fwdChannelId: m.fwdChannelId, attachment: m.attachment, sticker: m.sticker ?? null }
    : { body: m.body, fwdUserId: m.fwdUserId ?? author, fwdChannelId: null, attachment: m.attachment, sticker: m.sticker ?? null };

/** Источник пересылки глазами пересылающего; пересланное указывает на первоисточник. */
export function forwardSource(source: ForwardRef, u: DbUser) {
  if (source.from === 'dm') {
    const m = db.messages.find((x) => x.id === source.id && (x.fromId === u.id || x.toId === u.id));
    if (!m) fail(404, 'Сообщение для пересылки не найдено');
    return origin(m!, m!.fromId);
  }
  if (source.from === 'channel') {
    const post = db.channelPosts.find((x) => x.id === source.id);
    if (!post) fail(404, 'Сообщение для пересылки не найдено');
    if (pollOf('channel', post!.id)) fail(400, 'Опрос переслать нельзя');
    return { body: post!.body, fwdUserId: null, fwdChannelId: post!.channelId, attachment: post!.attachment, sticker: null };
  }
  const m = db.chatMessages.find((x) => x.id === source.id && memberRow(x.chatId, u.id) && !hidden(x.authorId));
  if (!m) fail(404, 'Сообщение для пересылки не найдено');
  if (pollOf('chat', m!.id)) fail(400, 'Опрос переслать нельзя');
  return origin(m!, m!.authorId);
}

// ─ Живая витрина ──────────────────────────────────────────────────────────

/** Марина «всегда в сети» и отвечает: прочитает, попечатает, ответит. Так в
 *  витрине видно галочки, «печатает…» и ответ, не заводя второй вкладки. */
export const MARINA_REPLIES = [
  'Ага, поняла!',
  'Звучит отлично.',
  'Давай так и сделаем.',
  'Хм, надо подумать. Напишу вечером.',
  'Согласна 🙂',
];

export function marinaAnswers(me: DbUser) {
  const marina = byName('marina');
  if (!marina || blockedPair(me.id, marina.id)) return;
  const key = dmKey(me.id, marina.id);
  window.setTimeout(() => {
    for (const m of db.messages) if (m.fromId === me.id && m.toId === marina.id && !m.readAt) m.readAt = new Date().toISOString();
    setTyping(key, marina.id);
  }, 1_500);
  window.setTimeout(() => {
    clearTyping(key, marina.id);
    if (blockedPair(me.id, marina.id)) return;
    db.messages.push({
      id: id(), fromId: marina.id, toId: me.id,
      body: MARINA_REPLIES[Math.floor(Math.random() * MARINA_REPLIES.length)],
      createdAt: new Date().toISOString(), readAt: null, ...NO_EXTRAS,
    });
    notify({ userId: me.id, actorId: marina.id, kind: 'message' });
  }, 5_000);
}

export const KNOWN_STICKERS = new Set(STICKER_PACKS.flatMap((p) => p.stickers.map((s) => s.id)));

export const readSticker = (id: string) => (KNOWN_STICKERS.has(id) ? id : fail(400, 'Такого стикера нет'));

/** Страница переписки — и в личных сообщениях, и в чатах. */
export const CHAT_PAGE = 30;

export const BODY_MAX = 1000;
