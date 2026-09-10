import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import * as v from '../validate.js';

export const router = Router();

// Жаловаться может только вошедший: анонимная жалоба — это анонимный шум,
// по ней нельзя ни отсечь дубли, ни понять, кто сигналит.
router.use(requireAuth);

const REASONS = ['spam', 'abuse', 'adult', 'other'];

// Тип объекта задаёт и таблицу, в которой проверяется существование. Карта
// вместо цепочки if: список типов один, и он же используется для валидации,
// так что новый тип нельзя добавить, забыв проверку.
const TARGETS = {
  post: { table: 'posts', missing: 'Пост не найден' },
  comment: { table: 'comments', missing: 'Комментарий не найден' },
  user: { table: 'users', missing: 'Пользователь не найден' },
};

const NOTE_MAX = 300;

router.post('/', (req, res, next) => {
  try {
    const targetType = v.str(req.body?.targetType, 'тип объекта', { min: 1, max: 20 });
    if (!Object.hasOwn(TARGETS, targetType)) {
      return res.status(400).json({ error: 'Неизвестный тип объекта жалобы' });
    }

    // Number(), а не parseInt(): id приходит из JSON, где это уже число, и
    // parseInt(1e21) даёт 1 — жалоба на «объект 10²¹» молча уехала бы на
    // объект №1. Логическое и булево в id тоже не принимаем.
    const rawId = req.body?.targetId;
    const targetId = typeof rawId === 'number' || typeof rawId === 'string' ? Number(rawId) : NaN;
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'Некорректный id объекта' });
    }

    const reason = v.str(req.body?.reason, 'причина', { min: 1, max: 20 });
    if (!REASONS.includes(reason)) {
      return res.status(400).json({ error: `Причина должна быть одной из: ${REASONS.join(', ')}` });
    }

    // Комментарий к жалобе необязателен: заставлять человека объяснять
    // очевидный спам — лишний барьер перед тем, чтобы вообще пожаловаться.
    const note = v.str(req.body?.note ?? '', 'комментарий', { max: NOTE_MAX });

    const { table, missing } = TARGETS[targetType];
    // Имя таблицы приходит не из запроса, а из TARGETS — в SQL подставляется
    // только то, что перечислено в коде выше.
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(targetId);
    if (!exists) return res.status(404).json({ error: missing });

    if (targetType === 'user' && targetId === req.user.id) {
      return res.status(400).json({ error: 'Нельзя пожаловаться на себя' });
    }

    // INSERT OR IGNORE вместо предварительной выборки: уникальность уже
    // объявлена в схеме, и полагаться на неё честнее, чем на проверку,
    // между которой и вставкой всегда есть щель.
    const info = db.prepare(`
      INSERT OR IGNORE INTO reports (reporter_id, target_type, target_id, reason, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.user.id, targetType, targetId, reason, note, nowIso());

    const alreadyReported = info.changes === 0;

    // Панели модератора в проекте нет, и делать вид, что жалоба куда-то
    // уходит, нечестно: она ложится в таблицу и печатается в лог сервера —
    // тот же подход, что у письма для сброса пароля без RESEND_API_KEY.
    // Повтор не печатается: это второй клик, а не второй сигнал.
    if (!alreadyReported) {
      console.warn(
        `⚑ Жалоба: @${req.user.username} → ${targetType} #${targetId}, причина «${reason}»`
        + (note ? `, комментарий: ${note}` : ''),
      );
    }

    // 201 и на повторную жалобу: с точки зрения отправителя результат один и
    // тот же — сигнал принят. Флаг нужен только чтобы клиент не показывал
    // «Жалоба отправлена» второй раз как новость.
    res.status(201).json({ ok: true, alreadyReported });
  } catch (err) {
    next(err);
  }
});
