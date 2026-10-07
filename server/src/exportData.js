import { db } from './db.js';
import { linksOf } from './auth.js';
import { callLabel } from './messageExtras.js';
import { publicUrl } from './media.js';

/**
 * Выгрузка своих данных — всё, что человек сюда писал и настроил, одним
 * JSON-файлом, как «Экспорт данных» в Телеграме.
 *
 * Что внутри: профиль, записи, комментарии, отметки, закладки, подписки и
 * подписчики, личные переписки целиком (обе стороны — это разговор человека),
 * свои сообщения в группах, свои каналы с публикациями, подписки на каналы,
 * настройки, папки, черновики, отложенные, сеансы.
 *
 * Чего нет намеренно: хеша пароля, токенов сеансов, кодов и билетов входа —
 * это ключи от аккаунта, а не данные человека; чужих сообщений в группах —
 * группа общая, и её переписка не только его. Файлы вложений не вшиваются —
 * у каждого есть имя и ссылка, по которой его скачивает вошедший владелец.
 */
export function exportFor(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const name = (id) => db.prepare('SELECT username FROM users WHERE id = ?').get(id)?.username ?? null;
  const attachment = (kind, row) =>
    row.attach_path ? { kind: row.attach_kind, name: row.attach_name ?? null, url: `/api/attachments/${kind}/${row.id}` } : null;

  const posts = db.prepare('SELECT id, body, created_at, repost_of_id, quote_of_id, continues_id FROM posts WHERE author_id = ? ORDER BY id').all(userId)
    .map((p) => ({
      id: p.id, body: p.body, createdAt: p.created_at,
      // Репост и цитата — ссылкой на запись: чужой текст в свою выгрузку не кладём.
      repostOf: p.repost_of_id ?? null, quoteOf: p.quote_of_id ?? null,
      // Ветка: какую свою запись эта продолжает.
      continues: p.continues_id ?? null,
      media: db.prepare('SELECT path, type FROM post_media WHERE post_id = ? ORDER BY position').all(p.id)
        .map((m) => ({ type: m.type, url: publicUrl('media', m.path) })),
    }));

  // Отложенные записи — свои и ещё не опубликованные: тоже ваши данные.
  const postDraft = db.prepare('SELECT body, updated_at FROM post_drafts WHERE user_id = ?').get(userId);
  const scheduledPosts = db.prepare('SELECT body, send_at FROM scheduled_posts WHERE author_id = ? ORDER BY send_at').all(userId)
    .map((s) => ({ body: s.body, sendAt: s.send_at }));

  const comments = db.prepare(`
    SELECT c.id, c.post_id, c.body, c.created_at FROM comments c WHERE c.author_id = ? ORDER BY c.id
  `).all(userId).map((c) => ({ id: c.id, postId: c.post_id, body: c.body, createdAt: c.created_at }));

  const dms = db.prepare(`
    SELECT * FROM messages WHERE from_id = ? OR to_id = ? ORDER BY id
  `).all(userId, userId);
  const conversations = new Map();
  for (const m of dms) {
    const other = m.from_id === userId ? m.to_id : m.from_id;
    if (!conversations.has(other)) conversations.set(other, { with: name(other), messages: [] });
    conversations.get(other).messages.push({
      id: m.id,
      from: m.from_id === userId ? 'me' : name(m.from_id),
      body: m.call ? callLabel(m.call) : m.body,
      sticker: m.sticker ?? null,
      attachment: attachment('dm', m),
      createdAt: m.created_at,
      editedAt: m.edited_at ?? null,
    });
  }

  const groups = db.prepare(`
    SELECT c.id, c.title, cm.joined_at FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ? ORDER BY c.id
  `).all(userId).map((c) => ({
    id: c.id,
    title: c.title,
    joinedAt: c.joined_at,
    myMessages: db.prepare('SELECT * FROM chat_messages WHERE chat_id = ? AND author_id = ? ORDER BY id').all(c.id, userId)
      .map((m) => ({ id: m.id, body: m.body, sticker: m.sticker ?? null, attachment: attachment('chat', m), createdAt: m.created_at, editedAt: m.edited_at ?? null })),
  }));

  const ownChannels = db.prepare('SELECT * FROM channels WHERE owner_id = ? ORDER BY id').all(userId).map((c) => ({
    handle: c.handle,
    title: c.title,
    description: c.description,
    createdAt: c.created_at,
    posts: db.prepare('SELECT * FROM channel_posts WHERE channel_id = ? ORDER BY id').all(c.id)
      .map((p) => ({ id: p.id, body: p.body, attachment: attachment('channel', p), createdAt: p.created_at, editedAt: p.edited_at ?? null })),
  }));

  return {
    format: 'duet-export/1',
    exportedAt: new Date().toISOString(),
    profile: {
      username: u.username,
      displayName: u.display_name,
      bio: u.bio ?? '',
      email: u.email ?? null,
      phone: u.phone ?? null,
      createdAt: u.created_at,
      avatar: publicUrl('avatar', u.avatar_path),
      pinnedPostId: u.pinned_post_id ?? null,
      privateProfile: Boolean(u.private),
      cover: publicUrl('media', u.cover_path),
      links: linksOf(u.links),
    },
    privacy: { lastSeen: u.last_seen_privacy, phoneFind: u.phone_find, phoneShow: u.phone_show },
    posts,
    scheduledPosts,
    followedTags: db.prepare('SELECT tag FROM tag_follows WHERE user_id = ? ORDER BY created_at').all(userId).map((r) => r.tag),
    postDraft: postDraft ? { body: postDraft.body, updatedAt: postDraft.updated_at } : null,
    comments,
    likes: db.prepare('SELECT post_id, created_at FROM likes WHERE user_id = ? ORDER BY created_at').all(userId)
      .map((l) => ({ postId: l.post_id, at: l.created_at })),
    bookmarks: db.prepare('SELECT post_id, created_at FROM bookmarks WHERE user_id = ? ORDER BY created_at').all(userId)
      .map((b) => ({ postId: b.post_id, at: b.created_at })),
    following: db.prepare('SELECT u.username, f.created_at FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY f.created_at').all(userId)
      .map((f) => ({ username: f.username, since: f.created_at })),
    followers: db.prepare('SELECT u.username, f.created_at FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ? ORDER BY f.created_at').all(userId)
      .map((f) => ({ username: f.username, since: f.created_at })),
    blocked: db.prepare('SELECT u.username FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?').all(userId).map((b) => b.username),
    conversations: [...conversations.values()],
    groups,
    channels: {
      own: ownChannels,
      subscribed: db.prepare(`
        SELECT c.handle, c.title FROM channel_subscribers s JOIN channels c ON c.id = s.channel_id
        WHERE s.user_id = ? AND c.owner_id <> ? ORDER BY s.joined_at
      `).all(userId, userId).map((c) => ({ handle: c.handle, title: c.title })),
    },
    folders: db.prepare('SELECT title, types, exclude_muted, exclude_read FROM chat_folders WHERE user_id = ? ORDER BY position').all(userId)
      .map((f) => ({ title: f.title, types: f.types ? f.types.split(',') : [], excludeMuted: Boolean(f.exclude_muted), excludeRead: Boolean(f.exclude_read) })),
    drafts: db.prepare('SELECT kind, target_id, body, updated_at FROM drafts WHERE user_id = ?').all(userId)
      .map((d) => ({ kind: d.kind, targetId: d.target_id, body: d.body, updatedAt: d.updated_at })),
    scheduled: db.prepare('SELECT kind, target_id, body, send_at FROM scheduled_messages WHERE user_id = ? ORDER BY send_at').all(userId)
      .map((s) => ({ kind: s.kind, targetId: s.target_id, body: s.body, sendAt: s.send_at })),
    sessions: db.prepare('SELECT created_at, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at').all(userId)
      .map((s) => ({ createdAt: s.created_at, userAgent: s.user_agent ?? null })),
  };
}
