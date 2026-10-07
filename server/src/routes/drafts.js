import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { DRAFT_KINDS, DRAFT_MAX, POST_DRAFT_MAX, draftFor, postDraftOf, saveDraft, savePostDraft } from '../drafts.js';
import * as v from '../validate.js';

/**
 * Черновик одного чата: прочитать при открытии, сохранить по паузе в наборе.
 * Цель — как в адресе самого чата: логин собеседника, id группы, адрес
 * канала. Черновик можно держать только там, куда можно и написать: в группе,
 * где вы участник, и в своём канале. Чужое и несуществующее — одинаковый 404.
 */
export const router = Router();
router.use(requireAuth);

const NOT_FOUND = { error: 'Чат не найден' };

function targetOf(kind, raw, me) {
  if (kind === 'dm') {
    return db.prepare('SELECT id FROM users WHERE username = ?').get(String(raw).toLowerCase())?.id ?? null;
  }
  if (kind === 'chat') {
    const id = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(id)) return null;
    return db.prepare('SELECT chat_id AS id FROM chat_members WHERE chat_id = ? AND user_id = ?').get(id, me)?.id ?? null;
  }
  const handle = String(raw).toLowerCase().replace(/^@/, '');
  return db.prepare('SELECT id FROM channels WHERE handle = ? AND owner_id = ?').get(handle, me)?.id ?? null;
}

function resolve(req, res) {
  const { kind, target } = req.params;
  if (!DRAFT_KINDS.includes(kind)) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  const targetId = targetOf(kind, target, req.user.id);
  if (targetId == null) res.status(404).json(NOT_FOUND);
  return targetId == null ? null : { kind, targetId };
}

/* Черновик записи ленты — один сегмент пути, с черновиками чатов не пересекается. */
router.get('/post', (req, res) => {
  res.json({ draft: postDraftOf(req.user.id) });
});

router.put('/post', (req, res, next) => {
  try {
    const body = v.str(req.body?.body ?? '', 'черновик', { max: POST_DRAFT_MAX, trim: false });
    res.json({ draft: savePostDraft(req.user.id, body) });
  } catch (err) {
    next(err);
  }
});

router.get('/:kind/:target', (req, res) => {
  const found = resolve(req, res);
  if (!found) return;
  res.json({ draft: draftFor(req.user.id, found.kind, found.targetId) });
});

router.put('/:kind/:target', (req, res, next) => {
  try {
    const found = resolve(req, res);
    if (!found) return;
    // Без обрезки: пробел в конце или перевод строки — часть недописанного.
    const body = v.str(req.body?.body ?? '', 'черновик', { max: DRAFT_MAX[found.kind], trim: false });
    res.json({ draft: saveDraft(req.user.id, found.kind, found.targetId, body) });
  } catch (err) {
    next(err);
  }
});
