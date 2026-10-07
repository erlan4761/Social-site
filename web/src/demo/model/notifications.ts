import { type Notification as NotificationItem, type NotificationKind, type PrefKind } from '../../api';
import { type DbNotification, db, id } from '../store';
import { byId, author, blockedPair } from './people';
import { membersOf, memberRow } from './chats';
import { deviceName } from '../../device';

/** Настройки чатов, события и упоминания — как notifications.js, prefs.js, mentions.js. */

// ─ Уведомления ──────────────────────────────────────────────────────────────

export type NotifyInput = {
  userId: number;
  actorId: number;
  kind: NotificationKind;
  postId?: number;
  commentId?: number;
  chatId?: number;
  messageId?: number;
};

/**
 * Единственная точка создания события — как `notify()` на сервере. Все правила
 * живут здесь, а не размазаны по методам: себе не уведомляем, заблокированной
 * паре не уведомляем, лайк и подписка идемпотентны, сообщения схлопываются.
 */
export const prefOf = (userId: number, kind: PrefKind, targetId: number) =>
  db.prefs.find((x) => x.userId === userId && x.kind === kind && x.targetId === targetId);

export const mutedFor = (userId: number, kind: PrefKind, targetId: number | null) =>
  targetId != null && Boolean(prefOf(userId, kind, targetId)?.muted);

/**
 * Настройки строки списка. `lastAt` — время последнего сообщения: чат выходит
 * из архива с новым сообщением, если не приглушён (как inArchive() на сервере).
 */
export const prefFields = (userId: number, kind: PrefKind, targetId: number, lastAt: string | null = null) => {
  const x = prefOf(userId, kind, targetId);
  const archivedAt = x?.archivedAt ?? null;
  return {
    pinnedAt: x?.pinnedAt ?? null,
    muted: Boolean(x?.muted),
    archived: archivedAt != null && (Boolean(x?.muted) || !lastAt || lastAt <= archivedAt),
  };
};

/** Общий счётчик ЛС — без приглушённых собеседников. */
export const dmUnreadTotal = (userId: number) =>
  db.messages.filter((m) => m.toId === userId && !m.readAt && !mutedFor(userId, 'dm', m.fromId)).length;

export const dropPrefs = (kind: PrefKind, targetId: number, userId?: number) => {
  const gone = (x: { kind: PrefKind; targetId: number; userId: number }) =>
    x.kind === kind && x.targetId === targetId && (userId == null || x.userId === userId);
  db.prefs = db.prefs.filter((x) => !gone(x));
  // Черновики исчезают вместе с настройками: цель пропала — отправлять их некуда.
  db.drafts = db.drafts.filter((x) => !gone(x));
};

export function notify(input: NotifyInput) {
  const { userId, actorId, kind } = input;
  const post = input.postId ?? null;
  const comment = input.commentId ?? null;
  const chat = input.chatId ?? null;

  if (userId === actorId) return;
  if (blockedPair(userId, actorId)) return;
  // Приглушённая переписка событий не создаёт.
  if (kind === 'message' && mutedFor(userId, 'dm', actorId)) return;
  if (kind === 'chat_message' && mutedFor(userId, 'chat', chat)) return;

  const sameObject = (n: DbNotification) =>
    n.userId === userId && n.actorId === actorId && n.kind === kind
    && n.postId === post && n.commentId === comment && n.chatId === chat;

  // Лайк и подписка: включение-выключение не должно быть способом дёргать
  // человека бесконечно.
  if ((kind === 'like' || kind === 'follow' || kind === 'repost' || kind === 'follow_request') && db.notifications.some(sameObject)) return;

  // Сообщения схлопываются: на диалог или чат приходится не больше одного
  // непрочитанного события, иначе лента станет дублем переписки.
  if (kind === 'message' || kind === 'chat_message') {
    db.notifications = db.notifications.filter(
      (n) => n.readAt !== null
        || !(n.userId === userId && n.actorId === actorId && n.kind === kind && n.chatId === chat),
    );
  }

  db.notifications.push({
    id: id(), userId, actorId, kind,
    postId: post, commentId: comment, chatId: chat, messageId: input.messageId ?? null,
    createdAt: new Date().toISOString(), readAt: null,
  });
}

/**
 * «Вход в аккаунт» — как notifyLogin() на сервере: мимо notify() с его «себе
 * не уведомляем», автор события — сам человек.
 */
export function notifyLogin(userId: number) {
  db.notifications.push({
    id: id(), userId, actorId: userId, kind: 'new_login',
    postId: null, commentId: null, chatId: null, messageId: null,
    device: deviceName(typeof navigator === 'undefined' ? null : navigator.userAgent),
    createdAt: new Date().toISOString(), readAt: null,
  });
}

export const MENTION_RE = /(^|[^\p{L}\p{N}_@])@([a-z0-9_]{3,20})(?![a-z0-9_])/giu;

/** Упоминания сообщения заново — как saveMentions() в mentions.js. */
export function saveMentions(chatId: number, messageId: number, authorId: number, body: string) {
  const names = new Set([...body.matchAll(MENTION_RE)].map((m) => m[2].toLowerCase()));
  const targets = membersOf(chatId)
    .map((m) => byId(m.userId)!)
    .filter((u) => names.has(u.username) && u.id !== authorId && !blockedPair(authorId, u.id))
    .map((u) => u.id);
  const before = new Set(db.chatMentions.filter((x) => x.messageId === messageId).map((x) => x.userId));
  db.chatMentions = [...db.chatMentions.filter((x) => x.messageId !== messageId), ...targets.map((userId) => ({ messageId, userId }))];
  for (const userId of targets) {
    if (!before.has(userId)) notify({ userId, actorId: authorId, kind: 'mention', chatId, messageId });
  }
  db.notifications = db.notifications.filter(
    (n) => !(n.kind === 'mention' && n.messageId === messageId && !n.readAt && !targets.includes(n.userId)),
  );
}

/** Непрочитанные упоминания в чате — id сообщений по порядку, как у сервера для кнопки «@». */
export const unreadMentionIds = (chatId: number, userId: number) => {
  const lastRead = memberRow(chatId, userId)?.lastReadId ?? 0;
  return db.chatMentions
    .filter((x) => x.userId === userId && x.messageId > lastRead && db.chatMessages.some((m) => m.id === x.messageId && m.chatId === chatId))
    .map((x) => x.messageId)
    .sort((a, b) => a - b);
};

export const unreadMentions = (chatId: number, userId: number) => unreadMentionIds(chatId, userId).length;

/** Снятие лайка и отписка убирают только **непрочитанное** событие о себе. */
export function dropNotification(input: NotifyInput) {
  const post = input.postId ?? null;
  const chat = input.chatId ?? null;
  db.notifications = db.notifications.filter(
    (n) => n.readAt !== null
      || !(n.userId === input.userId && n.actorId === input.actorId && n.kind === input.kind
        && n.postId === post && n.chatId === chat),
  );
}

/** Гасит события получателя; необязательные фильтры сужают выборку. */
export function markNotificationsRead(filter: {
  userId: number; kind?: NotificationKind; actorId?: number; chatId?: number;
}) {
  const now = new Date().toISOString();
  for (const n of db.notifications) {
    if (n.readAt || n.userId !== filter.userId) continue;
    if (filter.kind && n.kind !== filter.kind) continue;
    if (filter.actorId != null && n.actorId !== filter.actorId) continue;
    if (filter.chatId != null && n.chatId !== filter.chatId) continue;
    n.readAt = now;
  }
}

export const unreadNotifications = (userId: number) =>
  db.notifications.filter((n) => n.userId === userId && !n.readAt).length;

/** Первая строка предмета, обрезанная до 80 символов — как на сервере. */
export function excerpt(text: string) {
  const trimmed = text.trim();
  const line = trimmed.split('\n')[0].trim();
  if (line.length > 80) return `${line.slice(0, 80)}…`;
  return line.length < trimmed.length ? `${line}…` : line;
}

export const toNotification = (n: DbNotification): NotificationItem => {
  const post = n.postId != null ? db.posts.find((p) => p.id === n.postId) : undefined;
  const comment = n.commentId != null ? db.comments.find((c) => c.id === n.commentId) : undefined;
  const room = n.chatId != null ? db.chats.find((c) => c.id === n.chatId) : undefined;

  return {
    id: n.id,
    kind: n.kind,
    createdAt: n.createdAt,
    readAt: n.readAt,
    actor: author(byId(n.actorId)!),
    post: post ? { id: post.id, excerpt: excerpt(post.body) } : null,
    comment: comment ? { id: comment.id, excerpt: excerpt(comment.body) } : null,
    chat: room ? { id: room.id, title: room.title } : null,
    message: (() => {
      const m = n.messageId != null ? db.chatMessages.find((x) => x.id === n.messageId) : undefined;
      return m ? { id: m.id, excerpt: excerpt(m.body) } : null;
    })(),
    device: n.kind === 'new_login' ? n.device ?? null : null,
  };
};
