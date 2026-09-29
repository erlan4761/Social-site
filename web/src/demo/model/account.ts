import { type PrefKind } from '../../api';
import { type DbSession, db, id } from '../store';

/** Сеансы и удаление аккаунта — как routes/account.js. */

export function openSession(userId: number) {
  const s: DbSession = {
    id: id(), userId, createdAt: new Date().toISOString(),
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
  };
  db.sessions.push(s);
  db.currentSession = s.id;
}

/** Все сеансы человека, кроме текущего. Возвращает, сколько закрыто. */
export function endOtherSessions(userId: number) {
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.userId !== userId || s.id === db.currentSession);
  return before - db.sessions.length;
}

/**
 * Удаление аккаунта в витрине — то же, что каскад на сервере: всё его,
 * общие группы переходят старейшему участнику, группа, где он был один, и
 * его каналы исчезают вместе с тем, что на них ссылается.
 */
export function dropUser(uid: number) {
  const goneChats = new Set<number>();
  for (const c of db.chats.filter((x) => db.chatMembers.some((m) => m.chatId === x.id && m.userId === uid))) {
    const heir = db.chatMembers
      .filter((m) => m.chatId === c.id && m.userId !== uid)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
    if (heir) {
      if (c.ownerId === uid) c.ownerId = heir.userId;
    } else {
      goneChats.add(c.id);
    }
  }
  const goneChannels = new Set(db.channels.filter((c) => c.ownerId === uid).map((c) => c.id));
  const gonePosts = new Set(db.posts.filter((x) => x.authorId === uid).map((x) => x.id));
  const goneChannelPosts = new Set(
    db.channelPosts.filter((x) => goneChannels.has(x.channelId) || x.authorId === uid).map((x) => x.id),
  );
  const goneRef = (kind: PrefKind, target: number) =>
    (kind === 'dm' && target === uid) || (kind === 'chat' && goneChats.has(target)) || (kind === 'channel' && goneChannels.has(target));

  db.users = db.users.filter((x) => x.id !== uid);
  db.posts = db.posts.filter((x) => !gonePosts.has(x.id));
  db.comments = db.comments.filter((x) => x.authorId !== uid && !gonePosts.has(x.postId));
  db.likes = db.likes.filter((x) => x.userId !== uid && !gonePosts.has(x.postId));
  db.bookmarks = db.bookmarks.filter((x) => x.userId !== uid && !gonePosts.has(x.postId));
  db.follows = db.follows.filter((x) => x.followerId !== uid && x.followeeId !== uid);
  db.messages = db.messages.filter((x) => x.fromId !== uid && x.toId !== uid);
  db.dmReactions = db.dmReactions.filter((x) => x.userId !== uid && db.messages.some((m) => m.id === x.messageId));
  db.notifications = db.notifications.filter((x) => x.userId !== uid && x.actorId !== uid);
  db.blocks = db.blocks.filter((x) => x.blockerId !== uid && x.blockedId !== uid);
  db.reports = db.reports.filter((x) => x.reporterId !== uid);
  db.chats = db.chats.filter((x) => !goneChats.has(x.id));
  db.chatMembers = db.chatMembers.filter((x) => x.userId !== uid && !goneChats.has(x.chatId));
  db.chatMessages = db.chatMessages.filter((x) => x.authorId !== uid && !goneChats.has(x.chatId));
  db.chatReactions = db.chatReactions.filter((x) => x.userId !== uid && db.chatMessages.some((m) => m.id === x.messageId));
  db.channels = db.channels.filter((x) => !goneChannels.has(x.id));
  db.channelSubs = db.channelSubs.filter((x) => x.userId !== uid && !goneChannels.has(x.channelId));
  db.channelPosts = db.channelPosts.filter((x) => !goneChannelPosts.has(x.id));
  db.channelViews = db.channelViews.filter((x) => x.userId !== uid && !goneChannelPosts.has(x.postId));
  db.postReactions = db.postReactions.filter((x) => x.userId !== uid && !goneChannelPosts.has(x.messageId));
  db.channelComments = db.channelComments.filter((x) => x.authorId !== uid && !goneChannelPosts.has(x.postId));
  db.prefs = db.prefs.filter((x) => x.userId !== uid && !goneRef(x.kind, x.targetId));
  db.drafts = db.drafts.filter((x) => x.userId !== uid && !goneRef(x.kind, x.targetId));
  db.pins = db.pins.filter((x) =>
    !(x.kind === 'dm' && x.scope.split('-').map(Number).includes(uid)) &&
    !(x.kind === 'chat' && goneChats.has(Number(x.scope))) &&
    !(x.kind === 'channel' && goneChannels.has(Number(x.scope))));
  db.folders = db.folders
    .filter((f) => f.userId !== uid)
    .map((f) => ({
      ...f,
      include: f.include.filter((r) => !goneRef(r.kind, r.id)),
      exclude: f.exclude.filter((r) => !goneRef(r.kind, r.id)),
    }));
  db.sessions = db.sessions.filter((x) => x.userId !== uid);
  db.chatMentions = db.chatMentions.filter((x) => x.userId !== uid && db.chatMessages.some((m) => m.id === x.messageId));
  db.polls = db.polls.filter((x) =>
    x.kind === 'chat' ? db.chatMessages.some((m) => m.id === x.messageId) : db.channelPosts.some((m) => m.id === x.messageId));
  db.pollVotes = db.pollVotes.filter((v) => v.userId !== uid && db.polls.some((x) => x.id === v.pollId));
  db.scheduledMessages = db.scheduledMessages.filter((s) => s.userId !== uid);
}
