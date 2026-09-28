import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { blockPairSql } from '../blocks.js';
import { uploadPath } from '../media.js';

export const router = Router();

/**
 * Вложения переписки. В отличие от картинок в ленте, их нет в /uploads:
 * ссылка на фото из личного чата не должна открываться у того, кому её
 * перекинули. Файл отдаётся только тому, кто видит само сообщение, — та же
 * проверка, что у переписки: пара в ЛС, членство и блокировка в чате.
 * Чужое, удалённое и несуществующее неразличимы — 404.
 */
router.use(requireAuth);

const NOT_FOUND = 'Файл не найден';
const COLUMNS = 'm.attach_path, m.attach_kind, m.attach_mime, m.attach_name';

function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function send(res, row) {
  if (!row?.attach_path) return res.status(404).json({ error: NOT_FOUND });

  // Документ — только скачиванием: PDF или архив не должны открываться как
  // страница нашего сайта. Фото, видео и звук — на месте, в пузыре.
  const disposition = row.attach_kind === 'file' ? 'attachment' : 'inline';
  const name = row.attach_name || `file.${row.attach_path.split('.').pop()}`;
  res.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`);
  // Содержимое по этому адресу не меняется никогда (вложение не правится),
  // но кешировать его вправе только браузер получателя, а не прокси по пути.
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(row.attach_mime);
  // sendFile умеет Range: видео и голосовые перематываются без скачивания целиком.
  res.sendFile(uploadPath('attachment', row.attach_path), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: NOT_FOUND });
  });
}

router.get('/dm/:id', (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(404).json({ error: NOT_FOUND });
  const row = db.prepare(`
    SELECT ${COLUMNS} FROM messages m
    WHERE m.id = :id AND (m.from_id = :me OR m.to_id = :me)
  `).get({ id, me: req.user.id });
  send(res, row);
});

router.get('/chat/:id', (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(404).json({ error: NOT_FOUND });
  const row = db.prepare(`
    SELECT ${COLUMNS} FROM chat_messages m
    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = :viewerId
    WHERE m.id = :id AND ${blockPairSql('m.author_id')}
  `).get({ id, viewerId: req.user.id });
  send(res, row);
});
