import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { isBlockedPair } from '../blocks.js';
import { serializePoll } from '../polls.js';

/**
 * Голос и завершение опроса. Опрос виден тому же, кому видно его сообщение:
 * в группе — участнику (и не из-под блокировки с автором), в канале — любому,
 * кто вошёл. Всё остальное — 404, как у сообщений: чужой опрос и
 * несуществующий неразличимы.
 */
export const router = Router();
router.use(requireAuth);

const NOT_FOUND = 'Опрос не найден';

/** Опрос, если смотрящему видно его сообщение, и кто его создал. */
function visiblePoll(rawId, viewerId) {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!poll) return null;

  if (poll.chat_message_id != null) {
    const msg = db.prepare(`
      SELECT m.author_id FROM chat_messages m
      JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
      WHERE m.id = ?
    `).get(viewerId, poll.chat_message_id);
    if (!msg || isBlockedPair(viewerId, msg.author_id)) return null;
    return { poll, authorId: msg.author_id };
  }

  const post = db.prepare(`
    SELECT c.owner_id FROM channel_posts p JOIN channels c ON c.id = p.channel_id WHERE p.id = ?
  `).get(poll.channel_post_id);
  return post ? { poll, authorId: post.owner_id } : null;
}

/**
 * Голос заменяет прежний целиком: `options` — все выбранные варианты сразу.
 * Пустой список — отозвать голос, как «Отменить голос» в Телеграме.
 */
router.put('/:id/vote', (req, res) => {
  const me = req.user.id;
  const found = visiblePoll(req.params.id, me);
  if (!found) return res.status(404).json({ error: NOT_FOUND });
  const { poll, authorId } = found;
  if (poll.closed_at) return res.status(400).json({ error: 'Опрос завершён — голосовать больше нельзя' });

  const raw = req.body?.options;
  if (!Array.isArray(raw) || raw.some((x) => !Number.isSafeInteger(x))) {
    return res.status(400).json({ error: 'Варианты — список номеров' });
  }
  const chosen = [...new Set(raw)];
  if (poll.quiz) {
    // Ответ в викторине — один и окончательный: иначе, увидев правильный, его
    // поправили бы задним числом.
    if (db.prepare('SELECT 1 FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(poll.id, me)) {
      return res.status(400).json({ error: 'Ответ в викторине не меняют' });
    }
    if (chosen.length !== 1) return res.status(400).json({ error: 'В викторине выбирают один ответ' });
  }
  if (!poll.multiple && chosen.length > 1) {
    return res.status(400).json({ error: 'В этом опросе можно выбрать только один вариант' });
  }
  const valid = new Set(db.prepare('SELECT id FROM poll_options WHERE poll_id = ?').all(poll.id).map((r) => r.id));
  if (chosen.some((x) => !valid.has(x))) return res.status(400).json({ error: 'Такого варианта в опросе нет' });

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(poll.id, me);
    const insert = db.prepare('INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?)');
    for (const optionId of chosen) insert.run(poll.id, optionId, me, nowIso());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ poll: serializePoll(poll, me, authorId) });
});

/** Завершить — только создатель, и навсегда: итог не должен меняться задним числом. */
router.put('/:id/close', (req, res) => {
  const me = req.user.id;
  const found = visiblePoll(req.params.id, me);
  if (!found) return res.status(404).json({ error: NOT_FOUND });
  if (found.authorId !== me) return res.status(403).json({ error: 'Завершить опрос может только его автор' });
  if (!found.poll.closed_at) {
    db.prepare('UPDATE polls SET closed_at = ? WHERE id = ?').run(nowIso(), found.poll.id);
  }
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(found.poll.id);
  res.json({ poll: serializePoll(poll, me, found.authorId) });
});
