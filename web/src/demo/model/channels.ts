import { type Channel, type ChannelComment, type ChannelPost } from '../../api';
import { type DbChannel, type DbChannelSub, type DbChannelPost, type DbChannelComment, db, fail } from '../store';
import { byId, requireMe, author, hidden } from './people';
import { reactionsOf } from './messages';
import { toPoll, pollOf } from './polls';

/** Каналы: подписки, публикации, комментарии. */

// ─ Каналы ────────────────────────────────────────────────────────────────────

export const CHANNEL_HANDLE_RE = /^[a-z][a-z0-9_]{3,31}$/;

export const channelBy = (handle: string) => db.channels.find((c) => c.handle === handle.toLowerCase().replace(/^@/, ''));

export function requireChannel(handle: string) {
  const u = requireMe()!;
  const c = channelBy(handle);
  if (!c) fail(404, 'Канал не найден');
  return { u, c: c! };
}

export function requireOwner(handle: string) {
  const { u, c } = requireChannel(handle);
  if (c.ownerId !== u.id) fail(403, 'Публиковать и править канал может только владелец');
  return { u, c };
}

export const subOf = (channelId: number, userId: number) =>
  db.channelSubs.find((s) => s.channelId === channelId && s.userId === userId);

/** Своё — не «непрочитанное»: владелец свои публикации и так видел. */
export function channelUnread(s: DbChannelSub) {
  const c = db.channels.find((x) => x.id === s.channelId);
  if (!c || c.ownerId === s.userId) return 0;
  return db.channelPosts.filter((p) => p.channelId === s.channelId && p.id > s.lastReadId).length;
}

export const toChannel = (c: DbChannel): Channel => {
  const owner = byId(c.ownerId);
  return {
    id: c.id, handle: c.handle, title: c.title, description: c.description, createdAt: c.createdAt,
    owner: owner ? author(owner) : null,
    iAmOwner: c.ownerId === db.meId,
    subscribed: db.meId != null && Boolean(subOf(c.id, db.meId)),
    subscriberCount: db.channelSubs.filter((s) => s.channelId === c.id).length,
    autoDelete: c.autoDelete ?? 0,
  };
};

export const toChannelPost = (p: DbChannelPost): ChannelPost => ({
  id: p.id, channelId: p.channelId, body: p.body, createdAt: p.createdAt, editedAt: p.editedAt,
  views: db.channelViews.filter((v) => v.postId === p.id).length,
  commentCount: db.channelComments.filter((c) => c.postId === p.id && !hidden(c.authorId)).length,
  attachment: p.attachment,
  expiresAt: p.expiresAt ?? null,
  albumId: p.albumId ?? null,
  reactions: reactionsOf(db.postReactions, p.id),
  poll: (() => {
    const poll = pollOf('channel', p.id);
    const c = db.channels.find((x) => x.id === p.channelId);
    return poll && c ? toPoll(poll, c.ownerId) : null;
  })(),
});

export const postsOf = (channelId: number) => db.channelPosts.filter((p) => p.channelId === channelId).sort((a, b) => a.id - b.id);

export function requirePost(channelId: number, postId: number) {
  const p = db.channelPosts.find((x) => x.id === postId && x.channelId === channelId);
  if (!p) fail(404, 'Публикация не найдена');
  return p!;
}

export const toChannelComment = (c: DbChannelComment): ChannelComment => ({
  id: c.id, body: c.body, createdAt: c.createdAt, author: author(byId(c.authorId)!),
});
