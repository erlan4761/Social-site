import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { PIN_LIMIT, PREF_KINDS, pinnedCount, prefsOf, prefFor, setPrefs } from '../prefs.js';

export const router = Router();

/**
 * Закрепить чат наверху списка и выключить у него уведомления. Адрес — вид и
 * то, по чему чат открывается в интерфейсе: логин собеседника, номер чата,
 * адрес канала. Настраивать можно только то, что есть в твоём списке: чужой
 * чат, канал без подписки и несуществующий собеседник неразличимы — 404.
 */
router.use(requireAuth);

const NOT_FOUND = 'Чат не найден';

function resolveTarget(kind, raw, me) {
  if (kind === 'dm') {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(String(raw).toLowerCase());
    return user && user.id !== me ? user.id : null;
  }
  if (kind === 'chat') {
    const id = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(id, me) ? id : null;
  }
  const channel = db.prepare(`
    SELECT c.id FROM channels c JOIN channel_subscribers s ON s.channel_id = c.id AND s.user_id = ?
    WHERE c.handle = ?
  `).get(me, String(raw).toLowerCase().replace(/^@/, ''));
  return channel?.id ?? null;
}

const flag = (value, name) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    const err = new Error(`«${name}» — true или false`);
    err.status = 400;
    throw err;
  }
  return value;
};

router.get('/:kind/:target', (req, res) => {
  const { kind } = req.params;
  if (!PREF_KINDS.includes(kind)) return res.status(404).json({ error: NOT_FOUND });
  const target = resolveTarget(kind, req.params.target, req.user.id);
  if (!target) return res.status(404).json({ error: NOT_FOUND });
  const pref = prefFor(prefsOf(req.user.id, kind), target);
  res.json({ pinned: Boolean(pref.pinnedAt), muted: pref.muted });
});

router.put('/:kind/:target', (req, res, next) => {
  try {
    const me = req.user.id;
    const { kind } = req.params;
    if (!PREF_KINDS.includes(kind)) return res.status(404).json({ error: NOT_FOUND });
    const target = resolveTarget(kind, req.params.target, me);
    if (!target) return res.status(404).json({ error: NOT_FOUND });

    const pinned = flag(req.body?.pinned, 'pinned');
    const muted = flag(req.body?.muted, 'muted');

    if (pinned) {
      const already = Boolean(prefFor(prefsOf(me, kind), target).pinnedAt);
      if (!already && pinnedCount(me) >= PIN_LIMIT) {
        return res.status(400).json({ error: `Закрепить можно не больше ${PIN_LIMIT} чатов` });
      }
    }

    const pref = setPrefs(me, kind, target, { pinned, muted });
    res.json({ pinned: Boolean(pref.pinnedAt), muted: pref.muted });
  } catch (err) {
    next(err);
  }
});
