import { type Chat, type ChatMessage, type ChatRole } from '../../api';
import { type DbChat, type DbChatMessage, db, fail } from '../store';
import { byId, requireMe, author, person, hidden } from './people';
import { reactionsOf, quoteOf, forwardedOf } from './messages';
import { toPoll, pollOf } from './polls';

/** Групповые чаты: участники, видимые сообщения, непрочитанное. */

// ─ Групповые чаты ───────────────────────────────────────────────────────────

export const membersOf = (chatId: number) =>
  db.chatMembers
    .filter((m) => m.chatId === chatId)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId - b.userId);

export const memberRow = (chatId: number, userId: number) =>
  db.chatMembers.find((m) => m.chatId === chatId && m.userId === userId);

/** Сообщения чата, видимые смотрящему: реплики заблокированных не выдаются,
 *  но состав участников остаётся полным. Порядок — старые сверху. */
export const visibleChatMessages = (chatId: number) =>
  db.chatMessages
    .filter((m) => m.chatId === chatId && !hidden(m.authorId))
    .sort((a, b) => a.id - b.id);

export const toChatMessage = (m: DbChatMessage): ChatMessage => ({
  id: m.id, chatId: m.chatId, body: m.body, createdAt: m.createdAt, author: author(byId(m.authorId)!),
  poll: (() => {
    const poll = pollOf('chat', m.id);
    return poll ? toPoll(poll, m.authorId) : null;
  })(),
  editedAt: m.editedAt,
  forwardedFrom: forwardedOf(m),
  replyTo: quoteOf(m.replyToId, visibleChatMessages(m.chatId)),
  reactions: reactionsOf(db.chatReactions, m.id),
  attachment: m.attachment,
  sticker: m.sticker ?? null,
  albumId: m.albumId ?? null,
  expiresAt: m.expiresAt ?? null,
});

/** Сообщение чата, видимое смотрящему, или 404. */
export function requireChatMessage(chatId: number, messageId: number) {
  const m = visibleChatMessages(chatId).find((x) => x.id === messageId);
  if (!m) fail(404, 'Сообщение не найдено');
  return m!;
}

/** Роль в группе — как roleOf() в chatRoles.js. */
export function roleOf(c: DbChat, userId: number): ChatRole | null {
  if (c.ownerId === userId) return 'owner';
  const row = memberRow(c.id, userId);
  if (!row) return null;
  return row.role === 'admin' ? 'admin' : 'member';
}

export const isAdmin = (c: DbChat, userId: number) => ['owner', 'admin'].includes(roleOf(c, userId) ?? '');

/** Владелец — любого, кроме себя; администратор — только обычного участника. */
export function outranks(c: DbChat, actorId: number, targetId: number) {
  const actor = roleOf(c, actorId);
  if (actor === 'owner') return targetId !== actorId;
  return actor === 'admin' && roleOf(c, targetId) === 'member';
}

export function nextPostAt(c: DbChat, userId: number) {
  if (!c.slowMode || isAdmin(c, userId)) return null;
  const mine = db.chatMessages.filter((m) => m.chatId === c.id && m.authorId === userId);
  if (mine.length === 0) return null;
  const last = Math.max(...mine.map((m) => Date.parse(m.createdAt)));
  const next = last + c.slowMode * 1000;
  return next > Date.now() ? new Date(next).toISOString() : null;
}

/** Почему нельзя написать — как postBlock() на сервере. */
export function postBlock(c: DbChat, userId: number, ignoreSlowMode = false) {
  if (isAdmin(c, userId)) return;
  if (c.adminsOnly) fail(403, 'Писать в эту группу могут только администраторы');
  const next = ignoreSlowMode ? null : nextPostAt(c, userId);
  if (next) {
    const left = Math.max(1, Math.ceil((Date.parse(next) - Date.now()) / 1000));
    fail(429, `Медленный режим: следующее сообщение — через ${left < 60 ? `${left} с` : `${Math.ceil(left / 60)} мин`}`);
  }
}

export const toChat = (c: DbChat): Chat => {
  const members = membersOf(c.id).map((m) => ({
    ...person(byId(m.userId)!),
    role: (m.userId === c.ownerId ? 'owner' : m.role === 'admin' ? 'admin' : 'member') as ChatRole,
  }));
  return {
    id: c.id,
    title: c.title,
    ownerId: c.ownerId,
    createdAt: c.createdAt,
    members,
    memberCount: members.length,
    iAmOwner: c.ownerId === db.meId,
    myRole: (db.meId != null ? roleOf(c, db.meId) : null) ?? 'member',
    slowMode: c.slowMode ?? 0,
    adminsOnly: Boolean(c.adminsOnly),
    autoDelete: c.autoDelete ?? 0,
    nextPostAt: db.meId != null ? nextPostAt(c, db.meId) : null,
    invite: c.invite ?? null,
  };
};

/** 128 случайных бит в base64url — как randomBytes(16) на сервере. */
export function newInvite() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Самая дальняя ватерлиния среди остальных участников — две галочки у своих. */
export const othersReadUpTo = (chatId: number, userId: number) =>
  db.chatMembers
    .filter((m) => m.chatId === chatId && m.userId !== userId)
    .reduce((top, m) => Math.max(top, m.lastReadId), 0);

export const chatUnread = (chatId: number, userId: number) => {
  const seen = memberRow(chatId, userId)?.lastReadId ?? 0;
  return visibleChatMessages(chatId).filter((m) => m.id > seen && m.authorId !== userId).length;
};

/**
 * Доступ к чату. Посторонний получает **404, а не 403**: существование чужого
 * чата не должно подтверждаться тем, кого в нём нет.
 */
export function requireChat(chatId: number) {
  const u = requireMe()!;
  const chat = db.chats.find((c) => c.id === chatId);
  if (!chat || !memberRow(chatId, u.id)) fail(404, 'Чат не найден');
  return { u, chat: chat! };
}

export const TITLE_MAX = 60;

export const MEMBERS_MAX = 20;

export function checkTitle(raw: unknown) {
  const title = typeof raw === 'string' ? raw.trim() : '';
  if (!title) fail(400, '«название чата»: минимум 1 символов');
  if (title.length > TITLE_MAX) fail(400, `«название чата»: максимум ${TITLE_MAX} символов`);
  return title;
}
