import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { blockPairSql, isBlockedPair } from '../blocks.js';
import { publicUrl } from '../media.js';
import { markNotificationsRead, notify } from '../notifications.js';
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

const MESSAGE_SELECT = `
  SELECT m.id, m.chat_id, m.body, m.created_at,
         u.id AS author_id, u.username AS author_username,
         u.display_name AS author_display_name, u.avatar_path AS author_avatar_path
  FROM chat_messages m
  JOIN users u ON u.id = m.author_id
`;

/** Ожидает строку, выбранную через MESSAGE_SELECT. */
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
});

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
    SELECT u.id, u.username, u.display_name, u.avatar_path
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
    members: members.map(person),
    memberCount: members.length,
    iAmOwner: chat.owner_id === viewerId,
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

/** Последнее сообщение, видимое смотрящему, — для превью в списке чатов. */
function lastVisibleMessage(chatId, viewerId) {
  const row = db.prepare(`
    ${MESSAGE_SELECT}
    WHERE m.chat_id = :chatId AND ${blockPairSql('m.author_id')}
    ORDER BY m.id DESC LIMIT 1
  `).get({ chatId, viewerId });

  return row ? serializeMessage(row) : null;
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

  const chats = rows.map((row) => {
    const lastMessage = lastVisibleMessage(row.id, me);
    return {
      ...serializeChat(row, me),
      unread: unreadIn(row.id, me, row.last_read_id),
      lastMessage,
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
    if (chat.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Переименовать чат может только владелец' });
    }

    const title = v.str(req.body?.title, 'название чата', { min: 1, max: MAX_TITLE });
    db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, chat.id);

    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chat.id);
    res.json({ chat: serializeChat(updated, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// Удаление уносит участников, сообщения и уведомления о чате — всё каскадом по
// внешним ключам, отдельная уборка не нужна.
router.delete('/:id', (req, res) => {
  const chat = memberChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: NOT_FOUND });
  if (chat.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Удалить чат может только владелец' });
  }

  db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
  res.json({ ok: true });
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

  res.json({
    chat: serializeChat(chat, me),
    messages: page.map(serializeMessage).reverse(),
    nextCursor: hasMore ? page.at(-1).id : null,
  });
});

router.post('/:id/messages', (req, res, next) => {
  try {
    const me = req.user.id;
    const chat = memberChat(req.params.id, me);
    if (!chat) return res.status(404).json({ error: NOT_FOUND });

    const body = v.str(req.body?.body, 'сообщение', { min: 1, max: MAX_BODY });
    const info = db.prepare(
      'INSERT INTO chat_messages (chat_id, author_id, body, created_at) VALUES (?, ?, ?, ?)',
    ).run(chat.id, me, body, nowIso());

    // Событие каждому участнику, кроме автора. Блокировку и схлопывание по
    // чату notify() берёт на себя: на чат приходится максимум одно
    // непрочитанное событие, иначе лента стала бы копией переписки.
    const others = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id <> ?')
      .all(chat.id, me);
    for (const member of others) {
      notify({ userId: member.user_id, actorId: me, kind: 'chat_message', chatId: chat.id });
    }

    const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(Number(info.lastInsertRowid));
    res.status(201).json({ message: serializeMessage(row) });
  } catch (err) {
    next(err);
  }
});

/**
 * Ватерлиния ставится на максимальный id чата, а не на id последнего видимого
 * сообщения: иначе сообщение заблокированного участника осталось бы «выше»
 * отметки навсегда и счётчик было бы нечем обнулить.
 */
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

  res.json({ ok: true, unread: 0 });
});

/* ─ Участники ──────────────────────────────────────────────────────────── */

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
    if (!leaving && chat.owner_id !== me) {
      return res.status(403).json({ error: 'Удалять участников может только владелец' });
    }

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chat.id, target.id);

      // Ушедший не должен остаться с непрочитанными событиями о чате, который
      // теперь отвечает ему 404: это была бы битая ссылка в ленте событий.
      // Прочитанное не трогаем — задним числом ленту не переписываем.
      db.prepare('DELETE FROM notifications WHERE user_id = ? AND chat_id = ? AND read_at IS NULL')
        .run(target.id, chat.id);

      const rest = db.prepare(
        'SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY joined_at, user_id LIMIT 1',
      ).get(chat.id);

      if (!rest) {
        // Ушёл последний — чат больше некому открыть. Сообщения и события
        // уходят каскадом.
        db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
      } else if (chat.owner_id === target.id) {
        // Владение переходит старейшему участнику: чат без владельца нельзя
        // было бы ни переименовать, ни удалить.
        db.prepare('UPDATE chats SET owner_id = ? WHERE id = ?').run(rest.user_id, chat.id);
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.json(leaving ? { ok: true, left: true } : { ok: true });
  } catch (err) {
    next(err);
  }
});
