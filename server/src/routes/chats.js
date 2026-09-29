import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { blockPairSql, isBlockedPair } from '../blocks.js';
import { publicUrl } from '../media.js';
import {
  ATTACH_COLUMNS, ATTACH_INSERT_COLUMNS, checkAlbum, readAlbum, FWD_COLUMNS, assertEditable, attachmentOf, attachmentUpload,
  attachmentValues, chatKey, clearTyping, readSticker, copyAttachment, decorate, dropAttachment, emojiOf, extraFields,
  forwardSource, fwdJoin, isForwarded, isTyping, readAttachment, replyIdOf, searchQuery, searchResult, searchRows,
  setTyping,
} from '../messageExtras.js';
import { markNotificationsRead, notify } from '../notifications.js';
import { dropPrefs, prefFor, prefsOf } from '../prefs.js';
import { presenceFor } from '../presence.js';
import { saveMentions, unreadMentions } from '../mentions.js';
import { createPoll, hasPoll, readPoll, withPolls } from '../polls.js';
import { pin, pinnedPreview, unpin, unpinIfPinned } from '../pins.js';
import { clearDraft, draftsOf, dropDrafts } from '../drafts.js';
import { SLOW_MODE_OPTIONS, heirOf, isAdmin, nextPostAt, outranks, postBlock, roleOf } from '../chatRoles.js';
import * as v from '../validate.js';

export const router = Router();

const PAGE_SIZE = 30;
const MAX_BODY = 1000;
const MAX_TITLE = 60;
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 20;

// Чат виден только своим участникам, и проверка членства стоит первой строкой
// в каждом хендлере. Идентификатор чата приходит из пути, но сам по себе он
// ничего не открывает: без строки в chat_members любой запрос заканчивается 404.
router.use(requireAuth);

// Не участник получает 404, а не 403. 403 подтвердил бы постороннему, что чат
// с таким номером существует, и перебором id можно было бы составить список
// чужих чатов вместе с их количеством.
const NOT_FOUND = 'Чат не найден';
const TOO_MANY_MEMBERS = `В чате не больше ${MAX_MEMBERS} участников`;

// Текст одинаков в обе стороны и не называет причину: заблокированный не должен
// по формулировке понять, что его именно заблокировали (тот же приём, что в ЛС).
const cannotAdd = (name) => `Добавить «${name}» в чат нельзя`;

/** Numeric route param, or null when it is not a usable id. */
function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const person = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  avatarUrl: publicUrl('avatar', row.avatar_path),
});

/** Участник с отметкой «в сети» — по тем же правилам, что собеседник в ЛС
 *  (presence.js): блокировка и настройка «кому видно время» действуют и тут. */
const member = (row, viewerId) => ({
  ...person(row),
  ...presenceFor(viewerId, row),
});

const MESSAGE_SELECT = `
  SELECT m.id, m.chat_id, m.body, m.created_at, m.reply_to_id, m.edited_at, m.fwd_user_id, m.fwd_channel_id, m.sticker, m.album_id, ${ATTACH_COLUMNS},
         u.id AS author_id, u.username AS author_username,
         u.display_name AS author_display_name, u.avatar_path AS author_avatar_path,
         ${FWD_COLUMNS}
  FROM chat_messages m
  JOIN users u ON u.id = m.author_id
  ${fwdJoin('m')}
`;

/** Ожидает строку, выбранную через MESSAGE_SELECT. Цитата и реакции — в `decorate()`. */
const serializeMessage = (row) => ({
  id: row.id,
  chatId: row.chat_id,
  body: row.body,
  createdAt: row.created_at,
  author: {
    id: row.author_id,
    username: row.author_username,
    displayName: row.author_display_name,
    avatarUrl: publicUrl('avatar', row.author_avatar_path),
  },
  attachment: attachmentOf('chat', row),
  ...extraFields(row),
});

/** «Тот же чат и не от заблокированного» — граница, внутри которой ищутся
 *  цитаты: ответ на скрытую реплику показывает «сообщение недоступно». */
const CHAT_SCOPE = `m.chat_id = :chatId AND ${blockPairSql('m.author_id')}`;

const decorateChat = (messages, chatId, viewerId) =>
  withPolls('chat', decorate('chat', messages, { viewerId, scope: CHAT_SCOPE, scopeParams: { chatId, viewerId } }), viewerId, (m) => m.author.id);

/** Сообщение этого чата по id из пути, видимое смотрящему, или null. */
function chatMessage(chatId, rawId, viewerId) {
  const id = intParam(rawId);
  if (!id) return null;
  return db.prepare(`${MESSAGE_SELECT} WHERE m.id = :id AND ${CHAT_SCOPE}`).get({ id, chatId, viewerId }) ?? null;
}

const MESSAGE_NOT_FOUND = 'Сообщение не найдено';

function findUserByName(name) {
  return db.prepare('SELECT id, username, display_name, avatar_path FROM users WHERE username = ?')
    .get(String(name).toLowerCase());
}

/**
 * Чат вместе с проверкой членства: возвращает строку `chats` или null, если
 * чата нет либо смотрящий в нём не состоит. Оба случая для вызывающего
 * одинаковы и дают 404 — см. NOT_FOUND.
 */
function memberChat(rawId, viewerId) {
  const id = intParam(rawId);
  if (!id) return null;

  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!chat) return null;

  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(id, viewerId);

  return member ? chat : null;
}

/**
 * Список участников отдаётся целиком, даже если с кем-то из них смотрящий в
 * блокировке: скрывать людей из состава — значит показывать чат, которого не
 * существует («трое», а в списке двое). Прячутся только их сообщения.
 */
function chatMembers(chatId) {
  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_path, u.last_seen_at, u.last_seen_privacy, cm.role
    FROM chat_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.chat_id = ?
    ORDER BY cm.joined_at, u.id
  `).all(chatId);
}

const serializeChat = (chat, viewerId) => {
  const members = chatMembers(chat.id);
  return {
    id: chat.id,
    title: chat.title,
    ownerId: chat.owner_id,
    createdAt: chat.created_at,
    members: members.map((row) => ({
      ...member(row, viewerId),
      role: row.id === chat.owner_id ? 'owner' : row.role === 'admin' ? 'admin' : 'member',
    })),
    memberCount: members.length,
    iAmOwner: chat.owner_id === viewerId,
    myRole: roleOf(chat, viewerId),
    slowMode: chat.slow_mode ?? 0,
    adminsOnly: Boolean(chat.admins_only),
    // Когда смотрящему снова можно написать в медленном режиме; null — уже можно.
    nextPostAt: nextPostAt(chat, viewerId),
    // Ссылку видит каждый участник: звать людей может любой (см. POST /:id/members).
    invite: chat.invite_token ?? null,
  };
};

/**
 * Непрочитанное по ватерлинии last_read_id. Свои сообщения не считаются, и
 * сообщения тех, с кем смотрящий в блокировке, — тоже: их не видно в чате, и
 * счётчик, который на них ссылается, невозможно обнулить чтением.
 * Та же формула, что в GET /api/badges.
 */
function unreadIn(chatId, viewerId, lastReadId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM chat_messages m
    WHERE m.chat_id = :chatId AND m.id > :lastReadId
      AND m.author_id <> :viewerId
      AND ${blockPairSql('m.author_id')}
  `).get({ chatId, lastReadId, viewerId }).c;
}

/**
 * Самая дальняя ватерлиния среди остальных участников: своё сообщение с id не
 * больше неё кто-то уже прочитал — две галочки, как в группах Телеграма. Кто
 * именно прочитал, не раскрывается: ватерлиния на это и не отвечает.
 */
function othersReadUpTo(chatId, viewerId) {
  return db.prepare(`
    SELECT COALESCE(MAX(last_read_id), 0) AS top
    FROM chat_members WHERE chat_id = ? AND user_id <> ?
  `).get(chatId, viewerId).top;
}

/** Последнее сообщение, видимое смотрящему, — для превью в списке чатов. */
function lastVisibleMessage(chatId, viewerId) {
  const row = db.prepare(`
    ${MESSAGE_SELECT}
    WHERE m.chat_id = :chatId AND ${blockPairSql('m.author_id')}
    ORDER BY m.id DESC LIMIT 1
  `).get({ chatId, viewerId });
  if (!row) return null;

  // Превью в списке: цитата и реакции там не показываются, запросы за ними не нужны.
  const { replyToId, ...last } = serializeMessage(row);
  // Опрос нужен и превью: по нему список пишет «Опрос: вопрос».
  return withPolls('chat', [{ ...last, replyTo: null, reactions: [] }], viewerId, (m) => m.author.id)[0];
}

/* ─ Список и создание ──────────────────────────────────────────────────── */

/**
 * Мои чаты, свежие сверху. Счётчик и превью считаются по каждому чату
 * отдельным запросом: чатов у человека десятки, а не тысячи, и три коротких
 * запроса на чат читаются куда лучше одного оконного, который пришлось бы
 * разбирать при каждой правке.
 */
router.get('/', (req, res) => {
  const me = req.user.id;

  const rows = db.prepare(`
    SELECT c.*, cm.last_read_id
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
  `).all(me);

  const prefs = prefsOf(me, 'chat');
  const drafts = draftsOf(me, 'chat');
  const chats = rows.map((row) => {
    const lastMessage = lastVisibleMessage(row.id, me);
    const pref = prefFor(prefs, row.id);
    return {
      ...serializeChat(row, me),
      unread: unreadIn(row.id, me, row.last_read_id),
      mentions: unreadMentions(row.id, me, row.last_read_id),
      lastMessage,
      readUpTo: othersReadUpTo(row.id, me),
      pinnedAt: pref.pinnedAt,
      muted: pref.muted,
      draft: drafts.get(row.id) ?? null,
      // Только для сортировки, наружу не уходит: пустой чат должен стоять по
      // времени создания, иначе новый чат оказался бы в самом низу списка.
      sortKey: lastMessage ? lastMessage.createdAt : row.created_at,
    };
  });

  chats.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : b.id - a.id));

  res.json({
    chats: chats.map(({ sortKey, ...chat }) => chat),
    unreadTotal: chats.reduce((sum, chat) => sum + chat.unread, 0),
  });
});

router.post('/', (req, res, next) => {
  try {
    const me = req.user;
    const title = v.str(req.body?.title, 'название чата', { min: 1, max: MAX_TITLE });

    const raw = req.body?.members;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'Участники передаются массивом имён пользователей' });
    }
    // Лимит проверяется до разбора списка: незачем ходить в базу за тысячей
    // имён, чтобы потом отказать по количеству.
    if (raw.length + 1 > MAX_MEMBERS) return res.status(400).json({ error: TOO_MANY_MEMBERS });

    // Себя дублировать не нужно — создатель добавляется сам и становится
    // владельцем; повтор одного имени тоже не должен раздувать счётчик.
    const names = [];
    for (const item of raw) {
      const name = v.str(item, 'имя участника', { min: 1, max: 20 }).toLowerCase();
      if (name !== me.username && !names.includes(name)) names.push(name);
    }
    if (names.length + 1 < MIN_MEMBERS) {
      return res.status(400).json({ error: 'В чате должно быть не меньше двух участников' });
    }

    const members = [];
    for (const name of names) {
      const user = findUserByName(name);
      // В ошибке названо конкретное имя: из списка на десять человек иначе
      // непонятно, кого исправлять.
      if (!user) return res.status(400).json({ error: `Пользователь «${name}» не найден` });
      if (isBlockedPair(me.id, user.id)) return res.status(400).json({ error: cannotAdd(name) });
      members.push(user);
    }

    const createdAt = nowIso();
    let chatId;

    db.exec('BEGIN');
    try {
      const info = db.prepare('INSERT INTO chats (title, owner_id, created_at) VALUES (?, ?, ?)')
        .run(title, me.id, createdAt);
      chatId = Number(info.lastInsertRowid);

      const addMember = db.prepare(
        'INSERT INTO chat_members (chat_id, user_id, joined_at, last_read_id) VALUES (?, ?, ?, 0)',
      );
      // Владелец записывается первым: при передаче владения побеждает самый
      // ранний joined_at, и порядок вставки должен совпадать со здравым смыслом.
      addMember.run(chatId, me.id, createdAt);
      for (const user of members) addMember.run(chatId, user.id, createdAt);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    for (const user of members) {
      notify({ userId: user.id, actorId: me.id, kind: 'chat_invite', chatId });
    }

    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    res.status(201).json({ chat: serializeChat(chat, me.id) });
  } catch (err) {
    next(err);
  }
});

/* ─ Вступление по ссылке ──────────────────────────────────────────────────
 * Код — 128 случайных бит: угадать его нельзя, а раздавать удобно. Ссылку
 * создаёт, меняет и отключает владелец. По ней видно название и состав — ровно
 * то, что нужно, чтобы решить, вступать ли; переписка — только после.
 */

const INVITE_RE = /^[A-Za-z0-9_-]{16,64}$/;

function chatByInvite(raw) {
  const token = String(raw ?? '');
  return INVITE_RE.test(token) ? db.prepare('SELECT * FROM chats WHERE invite_token = ?').get(token) ?? null : null;
}

const INVITE_NOT_FOUND = 'Ссылка недействительна: её отключили или сменили';

router.get('/join/:token', (req, res) => {
  const chat = chatByInvite(req.params.token);
  if (!chat) return res.status(404).json({ error: INVITE_NOT_FOUND });
  const members = chatMembers(chat.id);
  res.json({
    chat: {
      id: chat.id,
      title: chat.title,
      memberCount: members.length,
      members: members.slice(0, 5).map((row) => member(row, req.user.id)),
    },
    member: members.some((m) => m.id === req.user.id),
  });
});

router.post('/join/:token', (req, res) => {
  const chat = chatByInvite(req.params.token);
  if (!chat) return res.status(404).json({ error: INVITE_NOT_FOUND });
  const me = req.user.id;
  // Уже внутри — не ошибка: второй щелчок по ссылке просто открывает чат.
  if (db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chat.id, me)) {
    return res.json({ chat: serializeChat(chat, me) });
  }
  // С владельцем в блокировке — нельзя, как нельзя и добавить такого вручную.
  if (isBlockedPair(me, chat.owner_id)) return res.status(403).json({ error: 'Вступить в этот чат нельзя' });
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM chat_members WHERE chat_id = ?').get(chat.id);
  if (count + 1 > MAX_MEMBERS) return res.status(400).json({ error: TOO_MANY_MEMBERS });

  // Пришедший по ссылке начинает с «сейчас»: история видна, но сотня старых
  // сообщений не падает на него непрочитанными.
  const top = db.prepare('SELECT COALESCE(MAX(id), 0) AS top FROM chat_messages WHERE chat_id = ?').get(chat.id).top;
  db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at, last_read_id) VALUES (?, ?, ?, ?)')
    .run(chat.id, me, nowIso(), top);
  res.status(201).json({ chat: serializeChat(chat, me) });
});

/* ─ Один чат ───────────────────────────────────────────────────────────── */

router.get('/:id', (req, res) => {
  const chat = memberChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });

  res.json({ chat: serializeChat(chat, req.user.id) });
});

router.patch('/:id', (req, res, next) => {
  try {
    const chat = memberChat(req.params.id, req.user.id);
    if (!chat) return res.status(404).json({ error: NOT_FOUND });
    // Здесь уже 403, а не 404: членство подтверждено, чат человек и так видит,
    // скрывать его существование не от кого.
    if (!isAdmin(chat, req.user.id)) {
      return res.status(403).json({ error: 'Менять группу могут владелец и администраторы' });
    }

    // Любое подмножество: название, медленный режим, «пишут только администраторы».
    const changes = {};
    if (req.body?.title !== undefined) changes.title = v.str(req.body.title, 'название чата', { min: 1, max: MAX_TITLE });
    if (req.body?.slowMode !== undefined) {
      if (!SLOW_MODE_OPTIONS.includes(req.body.slowMode)) {
        return res.status(400).json({ error: `Медленный режим — одно из: ${SLOW_MODE_OPTIONS.join(', ')} секунд` });
      }
      changes.slow_mode = req.body.slowMode;
    }
    if (req.body?.adminsOnly !== undefined) {
      if (typeof req.body.adminsOnly !== 'boolean') return res.status(400).json({ error: 'adminsOnly — да или нет' });
      changes.admins_only = req.body.adminsOnly ? 1 : 0;
    }
    if (Object.keys(changes).length === 0) return res.status(400).json({ error: 'Нечего менять' });
    for (const [column, value] of Object.entries(changes)) {
      db.prepare(`UPDATE chats SET ${column} = ? WHERE id = ?`).run(value, chat.id);
    }

    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chat.id);
    res.json({ chat: serializeChat(updated, req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** Файлы вложений чата. Строки уходят каскадом по внешним ключам, а файлы на
 *  диске каскад не видит — их собирают до удаления и стирают после. */
const chatAttachments = (chatId) =>
  db.prepare('SELECT attach_path FROM chat_messages WHERE chat_id = ? AND attach_path IS NOT NULL')
    .all(chatId).map((r) => r.attach_path);

// Удаление уносит участников, сообщения и уведомления о чате — всё каскадом по
// внешним ключам. Отдельно — только файлы вложений.
router.delete('/:id', (req, res) => {
  const chat = memberChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });
  if (chat.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Удалить чат может только владелец' });
  }

  const files = chatAttachments(chat.id);
  db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
  files.forEach(dropAttachment);
  unpin('chat', chat.id);
  dropPrefs({ kind: 'chat', targetId: chat.id });
  dropDrafts('chat', chat.id);
  res.json({ ok: true });
});

/** Создать или сменить ссылку-приглашение: прежняя сразу перестаёт работать. */
router.post('/:id/invite', (req, res) => {
  const chat = memberChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });
  if (!isAdmin(chat, req.user.id)) return res.status(403).json({ error: 'Ссылкой-приглашением управляют владелец и администраторы' });
  const token = randomBytes(16).toString('base64url');
  db.prepare('UPDATE chats SET invite_token = ? WHERE id = ?').run(token, chat.id);
  res.json({ invite: token });
});

router.delete('/:id/invite', (req, res) => {
  const chat = memberChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });
  if (!isAdmin(chat, req.user.id)) return res.status(403).json({ error: 'Ссылкой-приглашением управляют владелец и администраторы' });
  db.prepare('UPDATE chats SET invite_token = NULL WHERE id = ?').run(chat.id);
  res.json({ invite: null });
});

/* ─ Сообщения ──────────────────────────────────────────────────────────── */

/**
 * Переписка, старые сверху. Как в ЛС: берём последние PAGE_SIZE по id DESC и
 * разворачиваем — чат читается сверху вниз, а подгружается вверх, к старому.
 */
router.get('/:id/messages', (req, res) => {
  const me = req.user.id;
  const chat = memberChat(req.params.id, me);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });

  const cursor = intParam(req.query.cursor);

  // Сообщения тех, с кем смотрящий в блокировке, не выдаются, хотя сами люди
  // остаются в списке участников: блокировка прячет контент, а не человека.
  const rows = db.prepare(`
    ${MESSAGE_SELECT}
    WHERE m.chat_id = :chatId AND (:cursor IS NULL OR m.id < :cursor)
      AND ${blockPairSql('m.author_id')}
    ORDER BY m.id DESC
    LIMIT :limit
  `).all({ chatId: chat.id, viewerId: me, cursor, limit: PAGE_SIZE + 1 });

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  // Кто сейчас печатает — кроме себя и тех, с кем смотрящий в блокировке:
  // их реплик он не видит, и «печатает…» от них было бы обещанием, которое
  // никогда не сбудется.
  const typing = chatMembers(chat.id)
    .filter((u) => u.id !== me && isTyping(chatKey(chat.id), u.id) && !isBlockedPair(me, u.id))
    .map((u) => ({ id: u.id, displayName: u.display_name }));

  res.json({
    chat: serializeChat(chat, me),
    messages: decorateChat(page.map(serializeMessage).reverse(), chat.id, me),
    nextCursor: hasMore ? page.at(-1).id : null,
    readUpTo: othersReadUpTo(chat.id, me),
    typing,
    pinned: pinnedPreview('chat', chat.id, (id) => chatMessage(chat.id, id, me)),
  });
});

/**
 * Написать в чат: обычное сообщение, ответ (`replyTo` — сообщение этого же
 * чата) или пересылка (`forward: {from: 'dm'|'chat', id}`).
 */
router.post('/:id/messages', attachmentUpload.single('file'), async (req, res, next) => {
  let attachment = null;
  try {
    const me = req.user.id;
    const chat = memberChat(req.params.id, me);
    if (!chat) return res.status(404).json({ error: NOT_FOUND });
    // Альбом в медленном режиме — одно сообщение, как в Телеграме: второй и
    // следующие снимки того же альбома режим не задерживает (их не больше десяти).
    const album = req.file ? readAlbum(req.body?.album) : null;
    const albumRows = album ? db.prepare('SELECT author_id, chat_id FROM chat_messages WHERE album_id = ?').all(album) : [];
    const continuing = albumRows.length > 0 && albumRows.every((r) => r.author_id === me && r.chat_id === chat.id);
    const blocked = postBlock(chat, me, { ignoreSlowMode: continuing });
    if (blocked) {
      if (blocked.retryAfter) res.set('Retry-After', String(blocked.retryAfter));
      return res.status(blocked.status).json({ error: blocked.error });
    }

    // Опрос — JSON с полем poll: вопрос становится текстом сообщения.
    const poll = req.file || req.body?.poll == null ? null : readPoll(req.body.poll);
    const sticker = req.file || poll ? null : readSticker(req.body?.sticker);
    const forward = req.file || poll || sticker ? null : forwardSource(req.body?.forward, me);
    if (sticker && req.body?.body) return res.status(400).json({ error: 'Стикер отправляется без текста' });
    const body = poll
      ? poll.question
      : forward
        ? forward.body
        : sticker
          ? ''
          : v.str(req.body?.body ?? '', 'сообщение', { min: req.file ? 0 : 1, max: MAX_BODY });

    const replyTo = forward ? null : replyIdOf(req.body?.replyTo);
    if (replyTo != null && !chatMessage(chat.id, replyTo, me)) {
      return res.status(400).json({ error: 'Сообщение, на которое вы отвечаете, не найдено' });
    }

    // Файл — последним, как в ЛС: отказ не должен оставлять сироту на диске.
    attachment = forward ? await copyAttachment(forward.attachment) : await readAttachment(req.file, req.body);
    checkAlbum(album, attachment, albumRows, (r) => r.author_id === me && r.chat_id === chat.id);

    const info = db.prepare(`
      INSERT INTO chat_messages (chat_id, author_id, body, created_at, reply_to_id, fwd_user_id, fwd_channel_id, sticker, album_id, ${ATTACH_INSERT_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(chat.id, me, body, nowIso(), replyTo, forward?.fwdUserId ?? null, forward?.fwdChannelId ?? null, sticker ?? forward?.sticker ?? null, album, ...attachmentValues(attachment));

    if (poll) createPoll('chat', Number(info.lastInsertRowid), poll);
    clearTyping(chatKey(chat.id), me);
    if (!poll && !sticker && !forward) clearDraft(me, 'chat', chat.id);

    // Событие каждому участнику, кроме автора. Блокировку и схлопывание по
    // чату notify() берёт на себя: на чат приходится максимум одно
    // непрочитанное событие, иначе лента стала бы копией переписки.
    const others = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id <> ?')
      .all(chat.id, me);
    for (const member of others) {
      notify({ userId: member.user_id, actorId: me, kind: 'chat_message', chatId: chat.id });
    }
    // У пересланного чужие слова: упоминания в них не зовут никого.
    if (!forward) saveMentions({ chatId: chat.id, messageId: Number(info.lastInsertRowid), authorId: me, body });

    const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(Number(info.lastInsertRowid));
    res.status(201).json({ message: decorateChat([serializeMessage(row)], chat.id, me)[0] });
  } catch (err) {
    if (attachment) dropAttachment(attachment.path);
    next(err);
  }
});

/** «Печатает…» в чате. Ответ всегда одинаковый. */
/** Поиск по чату — только среди видимых смотрящему реплик. */
router.get('/:id/search', (req, res, next) => {
  try {
    const me = req.user.id;
    const chat = memberChat(req.params.id, me);
    if (!chat) return res.status(404).json({ error: NOT_FOUND });
    const terms = searchQuery(req.query.q);
    const rows = terms.length === 0 ? [] : db.prepare(`
      SELECT m.id, m.body, m.created_at, m.attach_kind, m.attach_name, u.id AS author_id, u.display_name
      FROM chat_messages m JOIN users u ON u.id = m.author_id
      WHERE ${CHAT_SCOPE} ORDER BY m.id DESC
    `).all({ chatId: chat.id, viewerId: me });
    res.json({
      results: searchRows(rows, terms).map((row) =>
        searchResult(row, { id: row.author_id, displayName: row.display_name })),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/typing', (req, res) => {
  const chat = memberChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });
  setTyping(chatKey(chat.id), req.user.id);
  res.json({ ok: true });
});

/** Правка своего сообщения — в течение 48 часов, как в ЛС. */
router.patch('/:id/messages/:mid', (req, res, next) => {
  try {
    const me = req.user.id;
    const chat = memberChat(req.params.id, me);
    if (!chat) return res.status(404).json({ error: NOT_FOUND });

    const msg = chatMessage(chat.id, req.params.mid, me);
    if (!msg) return res.status(404).json({ error: MESSAGE_NOT_FOUND });
    assertEditable(msg.author_id, msg.created_at, me);
    if (isForwarded(msg)) return res.status(403).json({ error: 'Пересланное сообщение изменить нельзя' });
    if (msg.sticker) return res.status(403).json({ error: 'Стикер изменить нельзя' });
    if (hasPoll('chat', msg.id)) return res.status(403).json({ error: 'Опрос изменить нельзя — за него уже голосуют' });

    const body = v.str(req.body?.body ?? '', 'сообщение', { min: msg.attach_path ? 0 : 1, max: MAX_BODY });
    if (body !== msg.body) {
      db.prepare('UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?').run(body, nowIso(), msg.id);
      saveMentions({ chatId: chat.id, messageId: msg.id, authorId: me, body });
    }

    const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(msg.id);
    res.json({ message: decorateChat([serializeMessage(row)], chat.id, me)[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * Удалить у всех: автор — своё, владелец — любое в своём чате (как админ группы
 * в Телеграме: без этого у владельца не было бы способа убрать спам). Строка
 * стирается целиком, ответы на неё показывают «сообщение удалено».
 */
router.delete('/:id/messages/:mid', (req, res) => {
  const me = req.user.id;
  const chat = memberChat(req.params.id, me);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });

  const msg = chatMessage(chat.id, req.params.mid, me);
  if (!msg) return res.status(404).json({ error: MESSAGE_NOT_FOUND });
  if (msg.author_id !== me && !outranks(chat, me, msg.author_id)) {
    return res.status(403).json({ error: 'Удалить можно своё сообщение, а администратору — сообщения участников' });
  }

  db.prepare('DELETE FROM chat_messages WHERE id = ?').run(msg.id);
  unpinIfPinned('chat', chat.id, msg.id);
  dropAttachment(msg.attach_path);
  res.json({ ok: true });
});

/** Реакция: одна на человека, новая заменяет прежнюю. */
router.put('/:id/messages/:mid/reaction', (req, res, next) => {
  try {
    const me = req.user.id;
    const chat = memberChat(req.params.id, me);
    if (!chat) return res.status(404).json({ error: NOT_FOUND });

    const msg = chatMessage(chat.id, req.params.mid, me);
    if (!msg) return res.status(404).json({ error: MESSAGE_NOT_FOUND });

    const emoji = emojiOf(req.body?.emoji);
    db.prepare(`
      INSERT INTO chat_message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at
    `).run(msg.id, me, emoji, nowIso());

    res.json({ message: decorateChat([serializeMessage(msg)], chat.id, me)[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/messages/:mid/reaction', (req, res) => {
  const me = req.user.id;
  const chat = memberChat(req.params.id, me);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });

  const msg = chatMessage(chat.id, req.params.mid, me);
  if (!msg) return res.status(404).json({ error: MESSAGE_NOT_FOUND });

  db.prepare('DELETE FROM chat_message_reactions WHERE message_id = ? AND user_id = ?').run(msg.id, me);
  res.json({ message: decorateChat([serializeMessage(msg)], chat.id, me)[0] });
});

/**
 * Ватерлиния ставится на максимальный id чата, а не на id последнего видимого
 * сообщения: иначе сообщение заблокированного участника осталось бы «выше»
 * отметки навсегда и счётчик было бы нечем обнулить.
 */
/** Закрепить сообщение в группе — владелец, как админ группы в Телеграме. */
router.put('/:id/messages/:mid/pin', (req, res) => {
  const me = req.user.id;
  const chat = memberChat(req.params.id, me);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });
  if (!isAdmin(chat, me)) return res.status(403).json({ error: 'Закреплять сообщения могут владелец и администраторы' });
  const msg = chatMessage(chat.id, req.params.mid, me);
  if (!msg) return res.status(404).json({ error: MESSAGE_NOT_FOUND });
  pin('chat', chat.id, msg.id, me);
  res.json({ pinned: pinnedPreview('chat', chat.id, (id) => chatMessage(chat.id, id, me)) });
});

router.delete('/:id/pin', (req, res) => {
  const me = req.user.id;
  const chat = memberChat(req.params.id, me);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });
  if (!isAdmin(chat, me)) return res.status(403).json({ error: 'Откреплять сообщения могут владелец и администраторы' });
  unpin('chat', chat.id);
  res.json({ ok: true });
});

/**
 * Кто прочитал своё сообщение — как в группах Телеграма: только автору и по
 * тем же ватерлиниям, что дают две галочки. Прочитал — ватерлиния участника не
 * ниже id сообщения. Времени нет: ватерлиния двигается целиком, и «прочитано в
 * 15:00» было бы временем последнего захода, а не этого сообщения.
 *
 * Те, с кем автор в блокировке, не считаются ни в одну сторону: этого
 * сообщения они не видят, их ватерлиния над ним ничего не значит.
 */
router.get('/:id/messages/:mid/readers', (req, res) => {
  const me = req.user.id;
  const chat = memberChat(req.params.id, me);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });
  const msg = chatMessage(chat.id, req.params.mid, me);
  if (!msg) return res.status(404).json({ error: MESSAGE_NOT_FOUND });
  if (msg.author_id !== me) return res.status(403).json({ error: 'Кто прочитал, видно только автору сообщения' });

  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_path, u.last_seen_at, u.last_seen_privacy, cm.last_read_id
    FROM chat_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.chat_id = :chatId AND cm.user_id <> :viewerId AND ${blockPairSql('cm.user_id')}
    ORDER BY u.display_name
  `).all({ chatId: chat.id, viewerId: me });
  res.json({
    read: rows.filter((r) => r.last_read_id >= msg.id).map((r) => member(r, me)),
    unread: rows.filter((r) => r.last_read_id < msg.id).map((r) => member(r, me)),
  });
});

router.put('/:id/read', (req, res) => {
  const me = req.user.id;
  const chat = memberChat(req.params.id, me);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });

  const { top } = db.prepare('SELECT COALESCE(MAX(id), 0) AS top FROM chat_messages WHERE chat_id = ?')
    .get(chat.id);

  db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?')
    .run(top, chat.id, me);

  // Прочитанный чат гасит и событие о нём — иначе счётчик событий висел бы
  // после того, как переписка уже открыта и прочитана.
  markNotificationsRead({ userId: me, kind: 'chat_message', chatId: chat.id });
  markNotificationsRead({ userId: me, kind: 'mention', chatId: chat.id });

  res.json({ ok: true, unread: 0 });
});

/* ─ Участники ──────────────────────────────────────────────────────────── */

/** Сделать участника администратором или вернуть в участники — только владелец. */
function setAdmin(req, res, admin) {
  const me = req.user.id;
  const chat = memberChat(req.params.id, me);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });
  if (chat.owner_id !== me) return res.status(403).json({ error: 'Назначать администраторов может только владелец' });
  const target = findUserByName(req.params.username);
  const role = target ? roleOf(chat, target.id) : null;
  if (!role) return res.status(404).json({ error: 'Участник не найден' });
  if (role === 'owner') return res.status(400).json({ error: 'Владелец и так главный' });
  db.prepare('UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?').run(admin ? 'admin' : 'member', chat.id, target.id);
  res.json({ chat: serializeChat(chat, me) });
}

router.put('/:id/admins/:username', (req, res) => setAdmin(req, res, true));
router.delete('/:id/admins/:username', (req, res) => setAdmin(req, res, false));

/**
 * Добавлять может любой участник: чат — общая комната, а не собственность
 * владельца. Удалять при этом может только владелец, иначе взаимное удаление
 * превратилось бы в способ выкинуть кого угодно.
 */
router.post('/:id/members', (req, res, next) => {
  try {
    const me = req.user.id;
    const chat = memberChat(req.params.id, me);
    if (!chat) return res.status(404).json({ error: NOT_FOUND });

    const name = v.str(req.body?.username, 'имя пользователя', { min: 1, max: 20 }).toLowerCase();
    const user = findUserByName(name);
    // 400, а не 404: в этом роутере 404 означает «нет такого чата», и второй
    // смысл у того же кода сделал бы ответ неоднозначным для клиента.
    if (!user) return res.status(400).json({ error: `Пользователь «${name}» не найден` });

    const already = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
      .get(chat.id, user.id);
    if (already) return res.status(400).json({ error: 'Этот человек уже в чате' });

    // Нельзя привести в общую комнату того, с кем вы в блокировке: писать друг
    // другу вы всё равно не сможете, а видеть друг друга начнёте.
    if (isBlockedPair(me, user.id)) return res.status(400).json({ error: cannotAdd(name) });

    const { count } = db.prepare('SELECT COUNT(*) AS count FROM chat_members WHERE chat_id = ?')
      .get(chat.id);
    if (count + 1 > MAX_MEMBERS) return res.status(400).json({ error: TOO_MANY_MEMBERS });

    db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at, last_read_id) VALUES (?, ?, ?, ?)')
      .run(chat.id, user.id, nowIso(), 0);

    notify({ userId: user.id, actorId: me, kind: 'chat_invite', chatId: chat.id });

    res.status(201).json({ chat: serializeChat(chat, me) });
  } catch (err) {
    next(err);
  }
});

/**
 * Один путь на два действия — уйти самому и удалить другого. Разница в правах:
 * выйти может каждый, удалить участника — только владелец.
 */
router.delete('/:id/members/:username', (req, res, next) => {
  try {
    const me = req.user.id;
    const chat = memberChat(req.params.id, me);
    if (!chat) return res.status(404).json({ error: NOT_FOUND });

    const target = findUserByName(req.params.username);
    const member = target
      ? db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chat.id, target.id)
      : null;
    if (!member) return res.status(404).json({ error: 'Участник не найден' });

    const leaving = target.id === me;
    if (!leaving && !outranks(chat, me, target.id)) {
      return res.status(403).json({ error: 'Удалять участников могут владелец, а администраторы — только обычных участников' });
    }

    let orphaned = [];
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chat.id, target.id);
      // Закреплённый у ушедшего чат не должен занимать место в его лимите.
      dropPrefs({ userId: target.id, kind: 'chat', targetId: chat.id });
      clearDraft(target.id, 'chat', chat.id);

      // Ушедший не должен остаться с непрочитанными событиями о чате, который
      // теперь отвечает ему 404: это была бы битая ссылка в ленте событий.
      // Прочитанное не трогаем — задним числом ленту не переписываем.
      db.prepare('DELETE FROM notifications WHERE user_id = ? AND chat_id = ? AND read_at IS NULL')
        .run(target.id, chat.id);

      const heir = heirOf(chat.id, target.id);

      if (heir == null) {
        // Ушёл последний — чат больше некому открыть. Сообщения и события
        // уходят каскадом, файлы вложений — после COMMIT.
        orphaned = chatAttachments(chat.id);
        db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
        unpin('chat', chat.id);
        dropPrefs({ kind: 'chat', targetId: chat.id });
      } else if (chat.owner_id === target.id) {
        // Владение переходит старейшему администратору, а без них — старейшему
        // участнику: чат без владельца нельзя было бы ни настроить, ни удалить.
        db.prepare('UPDATE chats SET owner_id = ? WHERE id = ?').run(heir, chat.id);
        db.prepare("UPDATE chat_members SET role = 'member' WHERE chat_id = ? AND user_id = ?").run(chat.id, heir);
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    orphaned.forEach(dropAttachment);

    res.json(leaving ? { ok: true, left: true } : { ok: true });
  } catch (err) {
    next(err);
  }
});
