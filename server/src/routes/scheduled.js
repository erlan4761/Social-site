import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { isBlockedPair } from '../blocks.js';
import { SCHEDULE_KINDS, deliver } from '../scheduled.js';
import { isAdmin } from '../chatRoles.js';
import * as v from '../validate.js';

/**
 * Отложенные сообщения (см. scheduled.js). Каждый видит и трогает только
 * свои; чужое и несуществующее — одинаковый 404. Переписка указывается так же,
 * как в настройках чата: логин собеседника, номер группы, адрес канала.
 */
export const router = Router();
router.use(requireAuth);

const NOT_FOUND = 'Отложенное сообщение не найдено';
const PENDING_MAX = 100;
const HORIZON_MS = 365 * 864e5;
const BODY_MAX = { dm: 1000, chat: 1000, channel: 4000 };

/** Куда писать: id собеседника, группы или своего канала — или null. */
function resolveTarget(kind, raw, me) {
  if (kind === 'dm') {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(String(raw).toLowerCase());
    return user && !isBlockedPair(me, user.id) ? user.id : null;
  }
  if (kind === 'chat') {
    const id = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(id, me) ? id : null;
  }
  // В канал отложить может только владелец — как и опубликовать.
  const channel = db.prepare('SELECT id FROM channels WHERE handle = ? AND owner_id = ?')
    .get(String(raw).toLowerCase().replace(/^@/, ''), me);
  return channel?.id ?? null;
}

function readSendAt(raw) {
  const at = typeof raw === 'string' ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) throw v.bad('Время отправки — дата в формате ISO');
  const ahead = at.getTime() - Date.now();
  if (ahead <= 0) throw v.bad('Время отправки уже прошло');
  if (ahead > HORIZON_MS) throw v.bad('Отложить можно не больше чем на год');
  return at.toISOString();
}

const serialize = (row) => ({ id: row.id, kind: row.kind, body: row.body, sendAt: row.send_at, createdAt: row.created_at });

const mine = (rawId, me) => {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return db.prepare('SELECT * FROM scheduled_messages WHERE id = ? AND user_id = ?').get(id, me) ?? null;
};

/** Отложенные в одной переписке, ближайшие сверху. */
router.get('/', (req, res) => {
  const me = req.user.id;
  const { kind, target } = req.query;
  if (!SCHEDULE_KINDS.includes(kind)) return res.status(400).json({ error: 'kind — dm, chat или channel' });
  const targetId = resolveTarget(kind, target ?? '', me);
  if (!targetId) return res.json({ scheduled: [] });
  const rows = db.prepare(`
    SELECT * FROM scheduled_messages WHERE user_id = ? AND kind = ? AND target_id = ? ORDER BY send_at, id
  `).all(me, kind, targetId);
  res.json({ scheduled: rows.map(serialize) });
});

router.post('/', (req, res, next) => {
  try {
    const me = req.user.id;
    const kind = req.body?.kind;
    if (!SCHEDULE_KINDS.includes(kind)) return res.status(400).json({ error: 'kind — dm, chat или channel' });
    const targetId = resolveTarget(kind, req.body?.target ?? '', me);
    if (!targetId) return res.status(404).json({ error: 'Переписка не найдена' });
    if (kind === 'chat') {
      // Иначе медленный режим обходился бы пачкой отложенных на одну минуту.
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(targetId);
      if (!isAdmin(chat, me) && (chat.admins_only || chat.slow_mode)) {
        return res.status(403).json({ error: chat.admins_only
          ? 'Писать в эту группу могут только администраторы'
          : 'В медленном режиме отложенные сообщения недоступны' });
      }
    }

    const body = v.str(req.body?.body, 'сообщение', { min: 1, max: BODY_MAX[kind] });
    const sendAt = readSendAt(req.body?.sendAt);
    const pending = db.prepare('SELECT COUNT(*) AS c FROM scheduled_messages WHERE user_id = ?').get(me).c;
    if (pending >= PENDING_MAX) return res.status(400).json({ error: `Отложенных сообщений — не больше ${PENDING_MAX}` });

    const info = db.prepare(`
      INSERT INTO scheduled_messages (user_id, kind, target_id, body, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(me, kind, targetId, body, sendAt, nowIso());
    res.status(201).json({ scheduled: serialize(db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(info.lastInsertRowid)) });
  } catch (err) {
    next(err);
  }
});

/** Поменять текст или время — частично, как у папок. */
router.patch('/:id', (req, res, next) => {
  try {
    const row = mine(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: NOT_FOUND });
    const body = req.body?.body === undefined ? row.body : v.str(req.body.body, 'сообщение', { min: 1, max: BODY_MAX[row.kind] });
    const sendAt = req.body?.sendAt === undefined ? row.send_at : readSendAt(req.body.sendAt);
    db.prepare('UPDATE scheduled_messages SET body = ?, send_at = ? WHERE id = ?').run(body, sendAt, row.id);
    res.json({ scheduled: serialize(db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(row.id)) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  const row = mine(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: NOT_FOUND });
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

/** «Отправить сейчас». Если за это время доступ пропал — 403, и очередь чиста. */
router.post('/:id/send', (req, res) => {
  const row = mine(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: NOT_FOUND });
  const id = deliver(row);
  if (id == null) return res.status(403).json({ error: 'Отправить уже нельзя — переписка недоступна' });
  res.json({ ok: true, messageId: id });
});
