import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { markNotificationsRead } from '../notifications.js';
import { emit, touchBadges, touchChat, touchDm } from '../live.js';

/**
 * «Прочитать все» — как в Телеграме: все личные переписки, группы и каналы
 * разом, включая приглушённые и архив. Вместе с ними гаснут события о
 * сообщениях и упоминаниях — иначе счётчик «Событий» висел бы после того, как
 * читать уже нечего.
 *
 * Отправителям личных сообщений уходит толчок — у них загораются вторые
 * галочки; участникам групп — тоже, «прочитано» там считается по ватерлиниям.
 */
export const router = Router();
router.use(requireAuth);

router.post('/', (req, res) => {
  const me = req.user.id;
  const now = nowIso();

  const senders = db.prepare('SELECT DISTINCT from_id FROM messages WHERE to_id = ? AND read_at IS NULL').all(me)
    .map((r) => r.from_id);
  const dms = Number(db.prepare('UPDATE messages SET read_at = ? WHERE to_id = ? AND read_at IS NULL').run(now, me).changes);

  // Ватерлиния — на последнее сообщение каждого чата, как у PUT /chats/:id/read.
  const chats = db.prepare(`
    SELECT cm.chat_id AS id, (SELECT COALESCE(MAX(m.id), 0) FROM chat_messages m WHERE m.chat_id = cm.chat_id) AS top
    FROM chat_members cm WHERE cm.user_id = ?
  `).all(me).filter((c) => c.top > 0);
  const moveChat = db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ? AND last_read_id < ?');
  const chatIds = chats.filter((c) => moveChat.run(c.top, c.id, me, c.top).changes > 0).map((c) => c.id);

  const channels = db.prepare(`
    SELECT s.channel_id AS id, (SELECT COALESCE(MAX(p.id), 0) FROM channel_posts p WHERE p.channel_id = s.channel_id) AS top
    FROM channel_subscribers s WHERE s.user_id = ?
  `).all(me);
  const moveChannel = db.prepare('UPDATE channel_subscribers SET last_read_id = ? WHERE channel_id = ? AND user_id = ? AND last_read_id < ?');
  const channelCount = channels.filter((c) => moveChannel.run(c.top, c.id, me, c.top).changes > 0).length;

  for (const kind of ['message', 'chat_message', 'mention']) markNotificationsRead({ userId: me, kind });

  for (const other of senders) touchDm(me, other);
  for (const id of chatIds) touchChat(id);
  touchBadges(me);
  // Другие вкладки того же человека перечитывают список.
  emit([me], { t: 'list' });

  res.json({ ok: true, dms, chats: chatIds.length, channels: channelCount });
});
