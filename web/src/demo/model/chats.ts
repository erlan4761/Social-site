import { type Chat, type ChatMessage } from '../../api';
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
});

/** Сообщение чата, видимое смотрящему, или 404. */
export function requireChatMessage(chatId: number, messageId: number) {
  const m = visibleChatMessages(chatId).find((x) => x.id === messageId);
  if (!m) fail(404, 'Сообщение не найдено');
  return m!;
}

export const toChat = (c: DbChat): Chat => {
  const members = membersOf(c.id).map((m) => person(byId(m.userId)!));
  return {
    id: c.id,
    title: c.title,
    ownerId: c.ownerId,
    createdAt: c.createdAt,
    members,
    memberCount: members.length,
    iAmOwner: c.ownerId === db.meId,
  };
};

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
