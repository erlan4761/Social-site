import { db, nowIso } from './db.js';

/**
 * «Живые» уведомления вкладкам — Server-Sent Events, без WebSocket и без
 * библиотек: браузерный EventSource сам держит соединение и переподключается.
 *
 * Сервер шлёт не данные, а толчок: «в переписке с 7 что-то изменилось»,
 * «в чате 12», «в канале 3», «проверь счётчики». Вкладка перечитывает нужное
 * обычными запросами — с теми же проверками доступа, блокировками и
 * «глазами смотрящего». Так правила остаются в одном месте, а поток не может
 * выдать ничего, чего человек не увидел бы и так.
 */

const HEARTBEAT_MS = 25_000;

/** Открытые потоки: кто, по какому сеансу и куда писать. */
const streams = new Set();

function write(entry, data) {
  entry.res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** GET /api/events — поток событий вошедшего человека. */
export function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx и похожие прокси иначе копили бы поток в буфере.
    'X-Accel-Buffering': 'no',
  });
  // Через сколько браузеру переподключаться после обрыва.
  res.write('retry: 3000\n\n');
  const entry = { userId: req.user.id, token: req.sessionToken, res };
  streams.add(entry);
  write(entry, { t: 'ready' });
  req.on('close', () => {
    streams.delete(entry);
    if (!hasStream(entry.userId)) goneListeners.forEach((fn) => fn(entry.userId));
  });
}

/** Кто хочет знать, что у человека закрылась последняя вкладка (звонки). */
const goneListeners = new Set();
export const onStreamsGone = (fn) => goneListeners.add(fn);

export const hasStream = (userId) => [...streams].some((e) => e.userId === userId);

export function emit(userIds, event) {
  const to = new Set(userIds);
  for (const entry of streams) if (to.has(entry.userId)) write(entry, typeof event === 'function' ? event(entry.userId) : event);
}

/** Есть ли у человека открытая вкладка — тогда пуш на телефон не нужен. */
export const isLive = hasStream;

/**
 * Закрывает потоки сеансов, которых больше нет: выход, «завершить сеанс»,
 * смена пароля, удаление аккаунта. Иначе закрытый сеанс продолжал бы
 * получать толчки — пусть и без данных, но с фактом «тебе написали».
 */
export function dropDeadStreams() {
  const valid = db.prepare('SELECT 1 FROM sessions WHERE token = ? AND expires_at > ?');
  const now = nowIso();
  for (const entry of streams) {
    if (!valid.get(entry.token, now)) {
      entry.res.end();
      streams.delete(entry);
      if (!hasStream(entry.userId)) goneListeners.forEach((fn) => fn(entry.userId));
    }
  }
}

// Пульс: прокси и туннели рвут молчащие соединения, а заодно — проверка
// сеансов, истёкших сами по себе.
setInterval(() => {
  dropDeadStreams();
  for (const entry of streams) entry.res.write(': ping\n\n');
}, HEARTBEAT_MS).unref();

/* ─ Кому толкать ─────────────────────────────────────────────────────── */

const userIdByName = (name) =>
  db.prepare('SELECT id FROM users WHERE username = ?').get(String(name).toLowerCase())?.id ?? null;

const chatMembers = (chatId) =>
  db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId).map((r) => r.user_id);

function channelAudience(channelId) {
  const owner = db.prepare('SELECT owner_id FROM channels WHERE id = ?').get(channelId)?.owner_id;
  const subs = db.prepare('SELECT user_id FROM channel_subscribers WHERE channel_id = ?').all(channelId).map((r) => r.user_id);
  return owner == null ? subs : [...subs, owner];
}

/** Переписка пары: каждому — «с кем», со своей стороны. */
export function touchDm(a, b) {
  emit([a, b], (userId) => ({ t: 'dm', with: userId === a ? b : a }));
}

export const touchChat = (chatId, extra = []) => emit([...chatMembers(chatId), ...extra], { t: 'chat', id: chatId });

export const touchChannel = (channelId, extra = []) => emit([...channelAudience(channelId), ...extra], { t: 'channel', id: channelId });

/** Счётчики и список: новое событие, прочитанное в другой вкладке. */
export const touchBadges = (userId) => emit([userId], { t: 'badges' });

/* ─ Толчки от запросов ─────────────────────────────────────────────────
 * Одна прослойка на префикс пути вместо вызова в каждом обработчике: всё, что
 * меняет переписку (кроме GET), после успешного ответа толкает её участников.
 * Состав берётся и до запроса, и после — чтобы узнал и тот, кого только что
 * убрали из группы, и тот, кого только что добавили.
 */

const firstSegment = (req) => decodeURIComponent(req.path.split('/')[1] ?? '');

const SCOPES = {
  dm: (req) => {
    const other = userIdByName(firstSegment(req));
    return other == null ? null : () => touchDm(req.user.id, other);
  },
  chat: (req) => {
    const segment = firstSegment(req);
    // Вступление по ссылке: чат — по коду приглашения из второго сегмента.
    const id = segment === 'join'
      ? db.prepare('SELECT id FROM chats WHERE invite_token = ?').get(decodeURIComponent(req.path.split('/')[2] ?? ''))?.id
      : Number.parseInt(segment, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const before = chatMembers(id);
    return () => touchChat(id, before);
  },
  channel: (req) => {
    const handle = firstSegment(req).toLowerCase().replace(/^@/, '');
    const channel = handle && db.prepare('SELECT id FROM channels WHERE handle = ?').get(handle);
    if (!channel) return null;
    const before = channelAudience(channel.id);
    return () => touchChannel(channel.id, before);
  },
  poll: (req) => {
    const id = Number.parseInt(firstSegment(req), 10);
    const poll = Number.isSafeInteger(id) && db.prepare('SELECT chat_message_id, channel_post_id FROM polls WHERE id = ?').get(id);
    if (!poll) return null;
    if (poll.chat_message_id != null) {
      const chatId = db.prepare('SELECT chat_id FROM chat_messages WHERE id = ?').get(poll.chat_message_id)?.chat_id;
      return chatId ? () => touchChat(chatId) : null;
    }
    const channelId = db.prepare('SELECT channel_id FROM channel_posts WHERE id = ?').get(poll.channel_post_id)?.channel_id;
    return channelId ? () => touchChannel(channelId) : null;
  },
  // Свои настройки, папки, события: другим вкладкам того же человека.
  self: (req) => () => emit([req.user.id], { t: 'list' }),
};

export function nudge(scope) {
  return (req, res, next) => {
    if (req.method === 'GET' || !req.user) return next();
    const fire = SCOPES[scope](req);
    if (fire) {
      res.on('finish', () => {
        if (res.statusCode < 400) fire();
      });
    }
    next();
  };
}
