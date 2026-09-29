import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { blockPairSql, isBlockedPair } from '../blocks.js';
import { publicUrl } from '../media.js';
import {
  ATTACH_COLUMNS, ATTACH_INSERT_COLUMNS, assertEditable, attachmentOf, attachmentUpload, attachmentValues,
  dropAttachment, emojiOf, reactionsFor, readAttachment, searchQuery, searchResult, searchRows,
} from '../messageExtras.js';
import { dropPrefs, prefFor, prefsOf } from '../prefs.js';
import { createPoll, hasPoll, readPoll, withPolls } from '../polls.js';
import { pin, pinnedPreview, unpin, unpinIfPinned } from '../pins.js';
import * as v from '../validate.js';

export const router = Router();

/**
 * Каналы — авторские ленты с подписчиками, как в Телеграме. Публикует только
 * владелец; читать, реагировать, комментировать и пересылать может любой, кто
 * вошёл: закрытых каналов нет. Адрес — @имя, по нему канал и ищут, и открывают.
 *
 * Блокировка здесь действует на людей, а не на канал: комментарии и реакции
 * того, с кем смотрящий в блокировке, не видны и не считаются, а комментировать
 * канал человека, с которым ты в блокировке, нельзя. Сам канал при этом виден —
 * это публичная лента, а не переписка с её автором.
 */
router.use(requireAuth);

const PAGE_SIZE = 20;
const MAX_POST = 4000;
const MAX_COMMENT = 1000;
const MAX_TITLE = 60;
const MAX_DESCRIPTION = 255;
const NOT_FOUND = 'Канал не найден';
const POST_NOT_FOUND = 'Публикация не найдена';

// Адрес канала: латиница, цифры и _, начинается с буквы, 4–32 символа —
// то, что можно продиктовать и набрать без ошибок.
const HANDLE_RE = /^[a-z][a-z0-9_]{3,31}$/;

function handleOf(value) {
  const handle = v.str(value, 'адрес канала', { min: 4, max: 32 }).toLowerCase().replace(/^@/, '');
  if (!HANDLE_RE.test(handle)) {
    throw v.bad('Адрес канала: 4–32 символа, латиница, цифры и _, начинается с буквы');
  }
  // `search` — это путь поиска (/api/channels/search), а не чей-то канал.
  if (handle === 'search') throw v.bad('Этот адрес зарезервирован');
  return handle;
}

function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const findChannel = (handle) =>
  db.prepare('SELECT * FROM channels WHERE handle = ?').get(String(handle ?? '').toLowerCase().replace(/^@/, ''));

/** Канал по адресу из пути или 404 — общее начало почти всех ручек. */
function channelOr404(req, res) {
  const channel = findChannel(req.params.handle);
  if (!channel) res.status(404).json({ error: NOT_FOUND });
  return channel;
}

function ownerOr403(channel, req, res) {
  if (channel.owner_id === req.user.id) return true;
  res.status(403).json({ error: 'Публиковать и править канал может только владелец' });
  return false;
}

const subscription = (channelId, userId) =>
  db.prepare('SELECT * FROM channel_subscribers WHERE channel_id = ? AND user_id = ?').get(channelId, userId);

const subscriberCount = (channelId) =>
  db.prepare('SELECT COUNT(*) AS c FROM channel_subscribers WHERE channel_id = ?').get(channelId).c;

function serializeChannel(c, viewerId) {
  const owner = db.prepare('SELECT username, display_name, avatar_path FROM users WHERE id = ?').get(c.owner_id);
  return {
    id: c.id,
    handle: c.handle,
    title: c.title,
    description: c.description,
    createdAt: c.created_at,
    owner: owner
      ? { id: c.owner_id, username: owner.username, displayName: owner.display_name, avatarUrl: publicUrl('avatar', owner.avatar_path) }
      : null,
    iAmOwner: c.owner_id === viewerId,
    subscribed: Boolean(subscription(c.id, viewerId)),
    subscriberCount: subscriberCount(c.id),
  };
}

const POST_SELECT = `
  SELECT m.id, m.channel_id, m.body, m.created_at, m.edited_at, ${ATTACH_COLUMNS},
         (SELECT COUNT(*) FROM channel_post_views pv WHERE pv.post_id = m.id) AS views,
         (SELECT COUNT(*) FROM channel_comments cc
          WHERE cc.post_id = m.id AND ${blockPairSql('cc.author_id')}) AS comment_count
  FROM channel_posts m
`;

/** Публикации с реакциями — одним запросом на страницу, как у переписки. */
function serializePosts(rows, viewerId) {
  const reactions = reactionsFor('channel', rows.map((r) => r.id), viewerId);
  // Автор опроса в канале — его владелец: ему видны результаты и «Завершить».
  const owners = new Map();
  const ownerOf = (channelId) => {
    if (!owners.has(channelId)) owners.set(channelId, db.prepare('SELECT owner_id FROM channels WHERE id = ?').get(channelId)?.owner_id);
    return owners.get(channelId);
  };
  return withPolls('channel', rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    views: row.views,
    commentCount: row.comment_count,
    attachment: attachmentOf('channel', row),
    reactions: reactions.get(row.id) ?? [],
  })), viewerId, (post) => ownerOf(post.channelId));
}

function channelPost(channelId, rawId, viewerId) {
  const id = intParam(rawId);
  if (!id) return null;
  return db.prepare(`${POST_SELECT} WHERE m.id = :id AND m.channel_id = :channelId`)
    .get({ id, channelId, viewerId }) ?? null;
}

const onePost = (row, viewerId) => serializePosts([row], viewerId)[0];

/** Непрочитанные публикации — по ватерлинии, как в групповых чатах. */
const unreadIn = (channelId, lastReadId) =>
  db.prepare('SELECT COUNT(*) AS c FROM channel_posts WHERE channel_id = ? AND id > ?').get(channelId, lastReadId).c;

/** Файлы вложений канала: каскад удаляет строки, а файлы на диске — нет. */
const channelAttachments = (channelId) =>
  db.prepare('SELECT attach_path FROM channel_posts WHERE channel_id = ? AND attach_path IS NOT NULL')
    .all(channelId).map((r) => r.attach_path);

/* ─ Список, поиск, создание ────────────────────────────────────────────── */

/** Мои подписки: последняя публикация, непрочитанное — для списка чатов. */
router.get('/', (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT c.*, s.last_read_id FROM channels c
    JOIN channel_subscribers s ON s.channel_id = c.id AND s.user_id = ?
  `).all(me);

  const prefs = prefsOf(me, 'channel');
  const channels = rows.map((c) => {
    const pref = prefFor(prefs, c.id);
    const last = db.prepare(`${POST_SELECT} WHERE m.channel_id = :channelId ORDER BY m.id DESC LIMIT 1`)
      .get({ channelId: c.id, viewerId: me });
    return {
      ...serializeChannel(c, me),
      // Своё — не «непрочитанное»: владелец свои публикации и так видел.
      unread: c.owner_id === me ? 0 : unreadIn(c.id, c.last_read_id),
      lastPost: last ? onePost(last, me) : null,
      pinnedAt: pref.pinnedAt,
      muted: pref.muted,
    };
  });
  channels.sort((a, b) =>
    (b.lastPost?.createdAt ?? b.createdAt).localeCompare(a.lastPost?.createdAt ?? a.createdAt));

  res.json({ channels, unreadTotal: channels.reduce((s, c) => s + c.unread, 0) });
});

/**
 * Поиск по названию и адресу. Фильтр на JS, а не LIKE: SQLite сравнивает без
 * учёта регистра только латиницу, и «ПЛЁНКА» не нашлась бы по «плёнка» — та
 * же причина, что у поиска людей. Каналов на порядки меньше, чем записей.
 */
router.get('/search', (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase().replace(/^@/, '').replace(/ё/g, 'е');
  if (q.length < 2) return res.json({ channels: [] });

  const fold = (s) => s.toLowerCase().replace(/ё/g, 'е');
  const found = db.prepare('SELECT * FROM channels').all()
    .filter((c) => fold(c.title).includes(q) || c.handle.includes(q))
    .map((c) => serializeChannel(c, req.user.id))
    .sort((a, b) => b.subscriberCount - a.subscriberCount)
    .slice(0, 20);

  res.json({ channels: found });
});

router.post('/', (req, res, next) => {
  try {
    const me = req.user.id;
    const title = v.str(req.body?.title, 'название канала', { min: 1, max: MAX_TITLE });
    const handle = handleOf(req.body?.handle);
    const description = v.str(req.body?.description ?? '', 'описание', { max: MAX_DESCRIPTION });

    if (findChannel(handle)) return res.status(409).json({ error: 'Этот адрес уже занят' });

    const now = nowIso();
    const info = db.prepare('INSERT INTO channels (handle, title, description, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(handle, title, description, me, now);
    // Владелец подписан на свой канал сразу: иначе его канала не было бы в его же списке чатов.
    db.prepare('INSERT INTO channel_subscribers (channel_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(Number(info.lastInsertRowid), me, now);

    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(info.lastInsertRowid));
    res.status(201).json({ channel: serializeChannel(channel, me) });
  } catch (err) {
    next(err);
  }
});

/* ─ Один канал ─────────────────────────────────────────────────────────── */

router.get('/:handle', (req, res) => {
  const channel = channelOr404(req, res);
  if (channel) res.json({ channel: serializeChannel(channel, req.user.id) });
});

/** Название и описание — владелец. Адрес не меняется: на него уже ведут ссылки. */
router.patch('/:handle', (req, res, next) => {
  try {
    const channel = channelOr404(req, res);
    if (!channel || !ownerOr403(channel, req, res)) return;

    const title = req.body?.title === undefined
      ? channel.title
      : v.str(req.body.title, 'название канала', { min: 1, max: MAX_TITLE });
    const description = req.body?.description === undefined
      ? channel.description
      : v.str(req.body.description, 'описание', { max: MAX_DESCRIPTION });

    db.prepare('UPDATE channels SET title = ?, description = ? WHERE id = ?').run(title, description, channel.id);
    res.json({ channel: serializeChannel(findChannel(channel.handle), req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:handle', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel) return;
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Удалить канал может только владелец' });

  const files = channelAttachments(channel.id);
  db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
  unpin('channel', channel.id);
  files.forEach(dropAttachment);
  dropPrefs({ kind: 'channel', targetId: channel.id });
  res.json({ ok: true });
});

/** Подписка идемпотентна: повторный PUT ничего не ломает и ничего не удваивает. */
router.put('/:handle/subscription', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel) return;

  // Подписчик читает с этого места: всё, что было раньше, — не «непрочитанное»,
  // иначе подписка на канал с сотней публикаций начиналась бы со счётчика 100.
  const top = db.prepare('SELECT COALESCE(MAX(id), 0) AS top FROM channel_posts WHERE channel_id = ?').get(channel.id).top;
  db.prepare(`
    INSERT INTO channel_subscribers (channel_id, user_id, joined_at, last_read_id) VALUES (?, ?, ?, ?)
    ON CONFLICT (channel_id, user_id) DO NOTHING
  `).run(channel.id, req.user.id, nowIso(), top);

  res.json({ channel: serializeChannel(channel, req.user.id) });
});

router.delete('/:handle/subscription', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel) return;
  if (channel.owner_id === req.user.id) {
    return res.status(400).json({ error: 'Владелец не может отписаться от своего канала' });
  }
  db.prepare('DELETE FROM channel_subscribers WHERE channel_id = ? AND user_id = ?').run(channel.id, req.user.id);
  dropPrefs({ userId: req.user.id, kind: 'channel', targetId: channel.id });
  res.json({ channel: serializeChannel(channel, req.user.id) });
});

/** Закреплённая публикация — владелец канала. */
router.put('/:handle/posts/:id/pin', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel || !ownerOr403(channel, req, res)) return;
  const post = channelPost(channel.id, req.params.id, req.user.id);
  if (!post) return res.status(404).json({ error: POST_NOT_FOUND });
  pin('channel', channel.id, post.id, req.user.id);
  res.json({ pinned: pinnedPreview('channel', channel.id, (id) => channelPost(channel.id, id, req.user.id)) });
});

router.delete('/:handle/pin', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel || !ownerOr403(channel, req, res)) return;
  unpin('channel', channel.id);
  res.json({ ok: true });
});

/** Поиск по публикациям канала. */
router.get('/:handle/search', (req, res, next) => {
  try {
    const channel = channelOr404(req, res);
    if (!channel) return;
    const terms = searchQuery(req.query.q);
    const rows = terms.length === 0 ? [] : db.prepare(
      'SELECT id, body, created_at, attach_kind, attach_name FROM channel_posts WHERE channel_id = ? ORDER BY id DESC',
    ).all(channel.id);
    res.json({ results: searchRows(rows, terms).map((row) => searchResult(row)) });
  } catch (err) {
    next(err);
  }
});

router.put('/:handle/read', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel) return;
  const top = db.prepare('SELECT COALESCE(MAX(id), 0) AS top FROM channel_posts WHERE channel_id = ?').get(channel.id).top;
  db.prepare('UPDATE channel_subscribers SET last_read_id = ? WHERE channel_id = ? AND user_id = ?')
    .run(top, channel.id, req.user.id);
  res.json({ ok: true });
});

/* ─ Публикации ─────────────────────────────────────────────────────────── */

/**
 * Лента канала, старые сверху, как переписка. Каждая выданная публикация
 * засчитывается как просмотр — по одному на человека: счётчик считает людей,
 * а не обновления страницы.
 */
router.get('/:handle/posts', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel) return;
  const me = req.user.id;
  const cursor = intParam(req.query.cursor);

  const rows = db.prepare(`
    ${POST_SELECT}
    WHERE m.channel_id = :channelId AND (:cursor IS NULL OR m.id < :cursor)
    ORDER BY m.id DESC LIMIT :limit
  `).all({ channelId: channel.id, cursor, limit: PAGE_SIZE + 1, viewerId: me });

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  const view = db.prepare('INSERT OR IGNORE INTO channel_post_views (post_id, user_id) VALUES (?, ?)');
  for (const row of page) {
    if (view.run(row.id, me).changes > 0) row.views += 1;
  }

  res.json({
    channel: serializeChannel(channel, me),
    posts: serializePosts(page, me).reverse(),
    nextCursor: hasMore ? page.at(-1).id : null,
    pinned: pinnedPreview('channel', channel.id, (id) => channelPost(channel.id, id, me)),
  });
});

/** Публикация: текст до 4000 символов и/или одно вложение — multipart, как в переписке. */
router.post('/:handle/posts', attachmentUpload.single('file'), async (req, res, next) => {
  let attachment = null;
  try {
    const channel = channelOr404(req, res);
    if (!channel || !ownerOr403(channel, req, res)) return;

    const poll = req.file || req.body?.poll == null ? null : readPoll(req.body.poll);
    const body = poll ? poll.question : v.str(req.body?.body ?? '', 'публикация', { min: req.file ? 0 : 1, max: MAX_POST });
    attachment = await readAttachment(req.file, req.body);

    const info = db.prepare(`
      INSERT INTO channel_posts (channel_id, author_id, body, created_at, ${ATTACH_INSERT_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(channel.id, req.user.id, body, nowIso(), ...attachmentValues(attachment));

    const id = Number(info.lastInsertRowid);
    if (poll) createPoll('channel', id, poll);
    // Автор свою публикацию видел — она не «непрочитанная» для него самого.
    db.prepare('UPDATE channel_subscribers SET last_read_id = ? WHERE channel_id = ? AND user_id = ?')
      .run(id, channel.id, req.user.id);

    res.status(201).json({ post: onePost(channelPost(channel.id, id, req.user.id), req.user.id) });
  } catch (err) {
    if (attachment) dropAttachment(attachment.path);
    next(err);
  }
});

router.patch('/:handle/posts/:id', (req, res, next) => {
  try {
    const channel = channelOr404(req, res);
    if (!channel || !ownerOr403(channel, req, res)) return;
    const post = channelPost(channel.id, req.params.id, req.user.id);
    if (!post) return res.status(404).json({ error: POST_NOT_FOUND });
    // Те же двое суток, что у сообщений: публикацию читали, на неё ссылаются.
    assertEditable(req.user.id, post.created_at, req.user.id);
    if (hasPoll('channel', post.id)) return res.status(403).json({ error: 'Опрос изменить нельзя — за него уже голосуют' });

    const body = v.str(req.body?.body ?? '', 'публикация', { min: post.attach_path ? 0 : 1, max: MAX_POST });
    if (body !== post.body) {
      db.prepare('UPDATE channel_posts SET body = ?, edited_at = ? WHERE id = ?').run(body, nowIso(), post.id);
    }
    res.json({ post: onePost(channelPost(channel.id, post.id, req.user.id), req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:handle/posts/:id', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel || !ownerOr403(channel, req, res)) return;
  const post = channelPost(channel.id, req.params.id, req.user.id);
  if (!post) return res.status(404).json({ error: POST_NOT_FOUND });

  db.prepare('DELETE FROM channel_posts WHERE id = ?').run(post.id);
  unpinIfPinned('channel', channel.id, post.id);
  dropAttachment(post.attach_path);
  res.json({ ok: true });
});

/** Реакция — одна на человека, как в переписке. Ставить может любой, кто вошёл. */
router.put('/:handle/posts/:id/reaction', (req, res, next) => {
  try {
    const channel = channelOr404(req, res);
    if (!channel) return;
    const post = channelPost(channel.id, req.params.id, req.user.id);
    if (!post) return res.status(404).json({ error: POST_NOT_FOUND });

    const emoji = emojiOf(req.body?.emoji);
    db.prepare(`
      INSERT INTO channel_post_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at
    `).run(post.id, req.user.id, emoji, nowIso());

    res.json({ post: onePost(post, req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:handle/posts/:id/reaction', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel) return;
  const post = channelPost(channel.id, req.params.id, req.user.id);
  if (!post) return res.status(404).json({ error: POST_NOT_FOUND });

  db.prepare('DELETE FROM channel_post_reactions WHERE message_id = ? AND user_id = ?').run(post.id, req.user.id);
  res.json({ post: onePost(post, req.user.id) });
});

/* ─ Комментарии ────────────────────────────────────────────────────────── */

const COMMENT_SELECT = `
  SELECT cc.id, cc.body, cc.created_at, u.id AS author_id, u.username, u.display_name, u.avatar_path
  FROM channel_comments cc JOIN users u ON u.id = cc.author_id
`;

const serializeComment = (row) => ({
  id: row.id,
  body: row.body,
  createdAt: row.created_at,
  author: {
    id: row.author_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: publicUrl('avatar', row.avatar_path),
  },
});

/** Ветка комментариев под публикацией — целиком, старые сверху. Комментарии
 *  тех, с кем смотрящий в блокировке, не выдаются. */
router.get('/:handle/posts/:id/comments', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel) return;
  const me = req.user.id;
  const post = channelPost(channel.id, req.params.id, me);
  if (!post) return res.status(404).json({ error: POST_NOT_FOUND });

  const rows = db.prepare(`
    ${COMMENT_SELECT}
    WHERE cc.post_id = :postId AND ${blockPairSql('cc.author_id')}
    ORDER BY cc.id
  `).all({ postId: post.id, viewerId: me });

  res.json({
    channel: serializeChannel(channel, me),
    post: onePost(post, me),
    comments: rows.map(serializeComment),
    // Комментировать канал того, с кем ты в блокировке, нельзя — поле ввода
    // заменяется плашкой, как в ЛС.
    canComment: !isBlockedPair(me, channel.owner_id),
  });
});

router.post('/:handle/posts/:id/comments', (req, res, next) => {
  try {
    const channel = channelOr404(req, res);
    if (!channel) return;
    const me = req.user.id;
    const post = channelPost(channel.id, req.params.id, me);
    if (!post) return res.status(404).json({ error: POST_NOT_FOUND });
    if (isBlockedPair(me, channel.owner_id)) {
      return res.status(403).json({ error: 'Комментировать этот канал нельзя' });
    }

    const body = v.str(req.body?.body, 'комментарий', { min: 1, max: MAX_COMMENT });
    const info = db.prepare('INSERT INTO channel_comments (post_id, author_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(post.id, me, body, nowIso());

    const row = db.prepare(`${COMMENT_SELECT} WHERE cc.id = ?`).get(Number(info.lastInsertRowid));
    res.status(201).json({ comment: serializeComment(row) });
  } catch (err) {
    next(err);
  }
});

/** Удалить комментарий: автор — свой, владелец канала — любой под своими публикациями. */
router.delete('/:handle/posts/:id/comments/:cid', (req, res) => {
  const channel = channelOr404(req, res);
  if (!channel) return;
  const post = channelPost(channel.id, req.params.id, req.user.id);
  const cid = intParam(req.params.cid);
  const comment = post && cid
    ? db.prepare('SELECT * FROM channel_comments WHERE id = ? AND post_id = ?').get(cid, post.id)
    : null;
  if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });
  if (comment.author_id !== req.user.id && channel.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Удалить можно только свой комментарий' });
  }

  db.prepare('DELETE FROM channel_comments WHERE id = ?').run(comment.id);
  res.json({ ok: true });
});
