import { type AttachmentInput, type Channel, type ChannelSummary, type PollInput } from '../../api';
import { type DbChannel, type DbChannelPost, type DbChannelComment, db, id, tick, fail } from '../store';
import { requireMe, blockedPair, hidden } from '../model/people';
import { EDIT_WINDOW_MS, attachmentFrom, setReaction, findHits } from '../model/messages';
import { pinnedOf, setPin, pinPreview } from '../model/folders';
import { prefFields, dropPrefs } from '../model/notifications';
import { clearDraft, draftOf } from '../model/drafts';
import { pollOf, readPoll, addPoll } from '../model/polls';
import { CHANNEL_HANDLE_RE, channelBy, requireChannel, requireOwner, subOf, channelUnread, toChannel, toChannelPost, postsOf, requirePost, toChannelComment } from '../model/channels';

/** Методы витрины: каналы. */

export const channelsApi = {
  // ─ Каналы ─────────────────────────────────────────────────────────────

  channels: () => {
    const u = requireMe()!;
    const list: ChannelSummary[] = db.channelSubs
      .filter((s) => s.userId === u.id)
      .map((s) => {
        const c = db.channels.find((x) => x.id === s.channelId)!;
        const last = postsOf(c.id).at(-1) ?? null;
        return {
          ...toChannel(c), unread: channelUnread(s), lastPost: last ? toChannelPost(last) : null,
          ...prefFields(u.id, 'channel', c.id),
          draft: draftOf(u.id, 'channel', c.id),
        };
      })
      .sort((a, b) => (b.lastPost?.createdAt ?? b.createdAt).localeCompare(a.lastPost?.createdAt ?? a.createdAt));
    return tick({ channels: list, unreadTotal: list.reduce((sum, c) => sum + c.unread, 0) });
  },

  searchChannels: (q: string) => {
    requireMe();
    const needle = q.trim().toLowerCase().replace(/^@/, '').replace(/ё/g, 'е');
    if (needle.length < 2) return tick({ channels: [] as Channel[] });
    const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
    return tick({
      channels: db.channels
        .filter((c) => fold(c.title).includes(needle) || c.handle.includes(needle))
        .map(toChannel)
        .sort((a, b) => b.subscriberCount - a.subscriberCount),
    });
  },

  createChannel: (input: { title: string; handle: string; description: string }) => {
    const u = requireMe()!;
    const title = input.title.trim();
    const handle = input.handle.trim().toLowerCase().replace(/^@/, '');
    if (!title) fail(400, '«название канала»: минимум 1 символов');
    if (title.length > 60) fail(400, '«название канала»: максимум 60 символов');
    if (!CHANNEL_HANDLE_RE.test(handle)) fail(400, 'Адрес канала: 4–32 символа, латиница, цифры и _, начинается с буквы');
    if (handle === 'search') fail(400, 'Этот адрес зарезервирован');
    if (channelBy(handle)) fail(409, 'Этот адрес уже занят');
    const c: DbChannel = {
      id: id(), handle, title, description: input.description.trim().slice(0, 255), ownerId: u.id,
      createdAt: new Date().toISOString(),
    };
    db.channels.push(c);
    db.channelSubs.push({ channelId: c.id, userId: u.id, joinedAt: c.createdAt, lastReadId: 0 });
    return tick({ channel: toChannel(c) });
  },

  channel: (handle: string) => tick({ channel: toChannel(requireChannel(handle).c) }),

  updateChannel: (handle: string, input: { title?: string; description?: string }) => {
    const { c } = requireOwner(handle);
    if (input.title !== undefined) {
      if (!input.title.trim()) fail(400, '«название канала»: минимум 1 символов');
      c.title = input.title.trim().slice(0, 60);
    }
    if (input.description !== undefined) c.description = input.description.trim().slice(0, 255);
    return tick({ channel: toChannel(c) });
  },

  deleteChannel: (handle: string) => {
    const { u, c } = requireChannel(handle);
    if (c.ownerId !== u.id) fail(403, 'Удалить канал может только владелец');
    const ids = new Set(postsOf(c.id).map((p) => p.id));
    db.channels = db.channels.filter((x) => x.id !== c.id);
    dropPrefs('channel', c.id);
    db.channelSubs = db.channelSubs.filter((s) => s.channelId !== c.id);
    db.channelPosts = db.channelPosts.filter((p) => p.channelId !== c.id);
    db.channelViews = db.channelViews.filter((v) => !ids.has(v.postId));
    db.postReactions = db.postReactions.filter((r) => !ids.has(r.messageId));
    db.channelComments = db.channelComments.filter((x) => !ids.has(x.postId));
    return tick({ ok: true as const });
  },

  subscribe: (handle: string, on: boolean) => {
    const { u, c } = requireChannel(handle);
    if (on) {
      // Подписчик читает с этого места: старое — не «непрочитанное».
      const top = postsOf(c.id).at(-1)?.id ?? 0;
      if (!subOf(c.id, u.id)) db.channelSubs.push({ channelId: c.id, userId: u.id, joinedAt: new Date().toISOString(), lastReadId: top });
    } else {
      if (c.ownerId === u.id) fail(400, 'Владелец не может отписаться от своего канала');
      db.channelSubs = db.channelSubs.filter((s) => !(s.channelId === c.id && s.userId === u.id));
      dropPrefs('channel', c.id, u.id);
    }
    return tick({ channel: toChannel(c) });
  },

  markChannelRead: (handle: string) => {
    const { u, c } = requireChannel(handle);
    const s = subOf(c.id, u.id);
    if (s) s.lastReadId = postsOf(c.id).at(-1)?.id ?? 0;
    return tick({ ok: true as const });
  },

  channelPosts: (handle: string, cursor?: number | null) => {
    const { u, c } = requireChannel(handle);
    let list = postsOf(c.id);
    if (cursor != null) list = list.filter((p) => p.id < cursor);
    const page = list.slice(-20);
    // Просмотр — один на человека.
    for (const p of page) {
      if (!db.channelViews.some((v) => v.postId === p.id && v.userId === u.id)) db.channelViews.push({ postId: p.id, userId: u.id });
    }
    return tick({
      channel: toChannel(c),
      posts: page.map(toChannelPost),
      nextCursor: list.length > 20 ? page[0].id : null,
      pinned: pinPreview('channel', c.id, postsOf(c.id)),
    });
  },

  publish: (handle: string, input: { body: string } | AttachmentInput) => {
    const { u, c } = requireOwner(handle);
    const body = (input.body ?? '').trim();
    const attachment = 'file' in input ? attachmentFrom(input) : null;
    if (!body && !attachment) fail(400, '«публикация»: минимум 1 символов');
    if (body.length > 4000) fail(400, '«публикация»: максимум 4000 символов');
    const post: DbChannelPost = {
      id: id(), channelId: c.id, authorId: u.id, body, createdAt: new Date().toISOString(), editedAt: null, attachment,
    };
    db.channelPosts.push(post);
    clearDraft(u.id, 'channel', c.id);
    const s = subOf(c.id, u.id);
    if (s) s.lastReadId = post.id;
    return tick({ post: toChannelPost(post) });
  },

  editPost: (handle: string, postId: number, text: string) => {
    const { c } = requireOwner(handle);
    const post = requirePost(c.id, postId);
    if (Date.now() - Date.parse(post.createdAt) > EDIT_WINDOW_MS) fail(403, 'Сообщение можно изменить только в течение 48 часов');
    if (pollOf('channel', post.id)) fail(403, 'Опрос изменить нельзя — за него уже голосуют');
    const body = text.trim();
    if (!body && !post.attachment) fail(400, '«публикация»: минимум 1 символов');
    if (body !== post.body) {
      post.body = body;
      post.editedAt = new Date().toISOString();
    }
    return tick({ post: toChannelPost(post) });
  },

  deleteChannelPost: (handle: string, postId: number) => {
    const { c } = requireOwner(handle);
    const post = requirePost(c.id, postId);
    db.channelPosts = db.channelPosts.filter((p) => p.id !== post.id);
    if (pinnedOf('channel', c.id)?.messageId === post.id) setPin('channel', c.id, null);
    db.channelComments = db.channelComments.filter((x) => x.postId !== post.id);
    db.postReactions = db.postReactions.filter((r) => r.messageId !== post.id);
    return tick({ ok: true as const });
  },

  reactPost: (handle: string, postId: number, emoji: string | null) => {
    const { u, c } = requireChannel(handle);
    const post = requirePost(c.id, postId);
    setReaction(db.postReactions, post.id, u.id, emoji);
    return tick({ post: toChannelPost(post) });
  },

  channelComments: (handle: string, postId: number) => {
    const { u, c } = requireChannel(handle);
    const post = requirePost(c.id, postId);
    return tick({
      channel: toChannel(c),
      post: toChannelPost(post),
      comments: db.channelComments.filter((x) => x.postId === post.id && !hidden(x.authorId)).sort((a, b) => a.id - b.id).map(toChannelComment),
      canComment: !blockedPair(u.id, c.ownerId),
    });
  },

  addChannelComment: (handle: string, postId: number, text: string) => {
    const { u, c } = requireChannel(handle);
    const post = requirePost(c.id, postId);
    if (blockedPair(u.id, c.ownerId)) fail(403, 'Комментировать этот канал нельзя');
    const body = text.trim();
    if (!body) fail(400, '«комментарий»: минимум 1 символов');
    if (body.length > 1000) fail(400, '«комментарий»: максимум 1000 символов');
    const comment: DbChannelComment = { id: id(), postId: post.id, authorId: u.id, body, createdAt: new Date().toISOString() };
    db.channelComments.push(comment);
    return tick({ comment: toChannelComment(comment) });
  },

  deleteChannelComment: (handle: string, postId: number, commentId: number) => {
    const { u, c } = requireChannel(handle);
    const post = requirePost(c.id, postId);
    const comment = db.channelComments.find((x) => x.id === commentId && x.postId === post.id);
    if (!comment) fail(404, 'Комментарий не найден');
    if (comment!.authorId !== u.id && c.ownerId !== u.id) fail(403, 'Удалить можно только свой комментарий');
    db.channelComments = db.channelComments.filter((x) => x.id !== commentId);
    return tick({ ok: true as const });
  },

  searchChannel: (handle: string, q: string) => {
    const { c } = requireChannel(handle);
    return tick({ results: findHits(q, postsOf(c.id), () => null) });
  },

  pinPost: (handle: string, postId: number) => {
    const { c } = requireOwner(handle);
    const post = requirePost(c.id, postId);
    setPin('channel', c.id, post.id);
    return tick({ pinned: pinPreview('channel', c.id, postsOf(c.id)) });
  },

  unpinPost: (handle: string) => {
    const { c } = requireOwner(handle);
    setPin('channel', c.id, null);
    return tick({ ok: true as const });
  },

  publishPoll: (handle: string, input: PollInput) => {
    const { u, c } = requireOwner(handle);
    const poll = readPoll(input);
    const post: DbChannelPost = {
      id: id(), channelId: c.id, authorId: u.id, body: poll.question, createdAt: new Date().toISOString(), editedAt: null, attachment: null,
    };
    db.channelPosts.push(post);
    addPoll('channel', post.id, poll);
    const s = subOf(c.id, u.id);
    if (s) s.lastReadId = post.id;
    return tick({ post: toChannelPost(post) });
  },
};
