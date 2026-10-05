import { db, nowIso } from './db.js';
import { isBlockedPair } from './blocks.js';
import { saveMentions } from './mentions.js';
import { notify } from './notifications.js';
import { touchChannel, touchChat, touchDm } from './live.js';
import { postBlock } from './chatRoles.js';
import { expiryFor, sweepExpired } from './autoDelete.js';
import { sweepSessions } from './auth.js';

/**
 * Отложенные сообщения — «отправить позже», как в Телеграме: в личную
 * переписку (и в «Избранное» — как напоминание себе), в группу и в свой канал.
 * Только текст: файл, пролежавший на диске неделю ради одного сообщения, —
 * лишняя морока с уборкой, а напоминания и анонсы и так пишут словами.
 *
 * Строка ждёт в scheduled_messages, раз в SCHEDULE_TICK_MS планировщик
 * забирает созревшие и отправляет их тем же путём, что и обычные: события,
 * упоминания, прочитанность у автора канала. Проверки доступа — в момент
 * отправки, а не создания: за неделю человека могли заблокировать или убрать
 * из группы, и тогда сообщение молча отменяется, а не прорывается сквозь запрет.
 */

export const SCHEDULE_KINDS = ['dm', 'chat', 'channel'];

function deliverDm(row, at) {
  const other = db.prepare('SELECT id FROM users WHERE id = ?').get(row.target_id);
  if (!other || isBlockedPair(row.user_id, other.id)) return null;
  const saved = other.id === row.user_id;
  const info = db.prepare('INSERT INTO messages (from_id, to_id, body, created_at, read_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.user_id, other.id, row.body, at, saved ? at : null, expiryFor('dm', other.id, row.user_id));
  if (!saved) notify({ userId: other.id, actorId: row.user_id, kind: 'message' });
  return Number(info.lastInsertRowid);
}

function deliverChat(row, at) {
  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(row.target_id, row.user_id);
  if (!member) return null;
  // За время ожидания группу могли закрыть для участников или включить медленный режим.
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(row.target_id);
  if (postBlock(chat, row.user_id)) return null;
  const info = db.prepare('INSERT INTO chat_messages (chat_id, author_id, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.target_id, row.user_id, row.body, at, expiryFor('chat', row.target_id));
  const id = Number(info.lastInsertRowid);
  for (const m of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id <> ?').all(row.target_id, row.user_id)) {
    notify({ userId: m.user_id, actorId: row.user_id, kind: 'chat_message', chatId: row.target_id });
  }
  saveMentions({ chatId: row.target_id, messageId: id, authorId: row.user_id, body: row.body });
  return id;
}

function deliverChannel(row, at) {
  const own = db.prepare('SELECT 1 FROM channels WHERE id = ? AND owner_id = ?').get(row.target_id, row.user_id);
  if (!own) return null;
  const info = db.prepare('INSERT INTO channel_posts (channel_id, author_id, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.target_id, row.user_id, row.body, at, expiryFor('channel', row.target_id));
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE channel_subscribers SET last_read_id = ? WHERE channel_id = ? AND user_id = ?')
    .run(id, row.target_id, row.user_id);
  return id;
}

const DELIVER = { dm: deliverDm, chat: deliverChat, channel: deliverChannel };

/**
 * Отправляет одно отложенное сообщение прямо сейчас и убирает его из очереди.
 * Возвращает id нового сообщения или null, если отправить уже нельзя.
 */
export function deliver(row) {
  let id = null;
  db.exec('BEGIN');
  try {
    // Строку удаляем первой: если два прохода планировщика встретятся, второй
    // не найдёт что удалять и не отправит сообщение дважды.
    const taken = db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(row.id).changes;
    if (taken) id = DELIVER[row.kind](row, nowIso());
    db.exec('COMMIT');
    // Ушло не из запроса, а по часам — толкаем участников сами.
    if (id != null) {
      if (row.kind === 'dm') touchDm(row.user_id, row.target_id);
      else if (row.kind === 'chat') touchChat(row.target_id);
      else touchChannel(row.target_id);
    }
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return id;
}

/** Отправляет всё созревшее. Возвращает, сколько строк забрано из очереди. */
export function deliverDue(now = new Date()) {
  const due = db.prepare('SELECT * FROM scheduled_messages WHERE send_at <= ? ORDER BY send_at, id')
    .all(now.toISOString());
  for (const row of due) {
    try {
      deliver(row);
    } catch (err) {
      console.error('Отложенное сообщение не отправлено:', err);
    }
  }
  return due.length;
}

export function startScheduler() {
  const every = Number(process.env.SCHEDULE_TICK_MS) || 15_000;
  // Тот же такт убирает сообщения с истёкшим автоудалением (autoDelete.js).
  // Каждый шаг — отдельно: сбой одного (например, база занята дольше
  // busy_timeout) не должен ни отменять остальные, ни ронять процесс —
  // исключение из setInterval убило бы сервер целиком. Следующий такт повторит.
  const step = (name, fn) => {
    try {
      fn();
    } catch (err) {
      console.error(`Такт планировщика: «${name}» не удался — повторим на следующем.`, err);
    }
  };
  const tick = () => {
    step('отложенные', deliverDue);
    step('автоудаление', sweepExpired);
    // И сеансы, которыми не пользовались дольше срока (auth.js).
    step('сеансы', sweepSessions);
  };
  const timer = setInterval(tick, every);
  timer.unref();
  tick();
}
