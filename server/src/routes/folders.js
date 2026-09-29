import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import * as v from '../validate.js';

export const router = Router();

/**
 * Папки чатов — у каждого свои, чужих не видно и не тронуть: чужая папка и
 * несуществующая неразличимы (404). Сервер хранит правило, а не список: какие
 * чаты в папку попадают, клиент считает сам по уже загруженному списку.
 */
router.use(requireAuth);

/** Как у Телеграма без подписки: десять папок, двенадцать символов в имени. */
const FOLDER_LIMIT = 10;
const TITLE_MAX = 12;
const ITEMS_MAX = 100;
const KINDS = ['dm', 'chat', 'channel'];
const NOT_FOUND = 'Папка не найдена';

function serialize(folder) {
  const items = db.prepare('SELECT kind, target_id, mode FROM chat_folder_items WHERE folder_id = ? ORDER BY kind, target_id')
    .all(folder.id);
  return {
    id: folder.id,
    title: folder.title,
    types: folder.types ? folder.types.split(',') : [],
    include: items.filter((i) => i.mode === 'include').map((i) => ({ kind: i.kind, id: i.target_id })),
    exclude: items.filter((i) => i.mode === 'exclude').map((i) => ({ kind: i.kind, id: i.target_id })),
    excludeMuted: Boolean(folder.exclude_muted),
    excludeRead: Boolean(folder.exclude_read),
  };
}

const myFolders = (userId) =>
  db.prepare('SELECT * FROM chat_folders WHERE user_id = ? ORDER BY position, id').all(userId);

function ownFolder(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  const folder = Number.isSafeInteger(id)
    ? db.prepare('SELECT * FROM chat_folders WHERE id = ? AND user_id = ?').get(id, req.user.id)
    : null;
  if (!folder) res.status(404).json({ error: NOT_FOUND });
  return folder;
}

/* ─ Проверка ввода ─────────────────────────────────────────────────────── */

function typesOf(value) {
  if (!Array.isArray(value)) throw v.bad('«types» — список видов чатов');
  const set = [...new Set(value)];
  if (set.some((t) => !KINDS.includes(t))) throw v.bad('Виды чатов — dm, chat или channel');
  return set.join(',');
}

function itemsOf(value, field) {
  if (!Array.isArray(value)) throw v.bad(`«${field}» — список чатов`);
  if (value.length > ITEMS_MAX) throw v.bad(`В «${field}» не больше ${ITEMS_MAX} чатов`);
  return value.map((item) => {
    const id = Number(item?.id);
    if (!KINDS.includes(item?.kind) || !Number.isSafeInteger(id) || id <= 0) {
      throw v.bad(`Чат в «${field}» — {kind: dm|chat|channel, id}`);
    }
    return { kind: item.kind, id };
  });
}

const bool = (value, field) => {
  if (typeof value !== 'boolean') throw v.bad(`«${field}» — true или false`);
  return value ? 1 : 0;
};

/**
 * Разбор тела для создания и правки. Пустая папка — без видов и без чатов —
 * бессмысленна: она всегда пуста, и её проще не создавать, чем объяснять.
 */
function readFolder(body, current = null) {
  const title = body?.title === undefined && current
    ? current.title
    : v.str(body?.title, 'название папки', { min: 1, max: TITLE_MAX });
  const types = body?.types === undefined && current ? current.types : typesOf(body?.types ?? []);
  const include = body?.include === undefined ? null : itemsOf(body.include, 'include');
  const exclude = body?.exclude === undefined ? null : itemsOf(body.exclude, 'exclude');
  const excludeMuted = body?.excludeMuted === undefined ? current?.exclude_muted ?? 0 : bool(body.excludeMuted, 'excludeMuted');
  const excludeRead = body?.excludeRead === undefined ? current?.exclude_read ?? 0 : bool(body.excludeRead, 'excludeRead');
  return { title, types, include, exclude, excludeMuted, excludeRead };
}

/** Чаты папки заменяются целиком: include и exclude — полные списки. Чат не
 *  может быть и добавлен, и исключён — исключение побеждает. */
function writeItems(folderId, include, exclude) {
  if (include) db.prepare("DELETE FROM chat_folder_items WHERE folder_id = ? AND mode = 'include'").run(folderId);
  if (exclude) db.prepare("DELETE FROM chat_folder_items WHERE folder_id = ? AND mode = 'exclude'").run(folderId);
  const put = db.prepare(`
    INSERT INTO chat_folder_items (folder_id, kind, target_id, mode) VALUES (?, ?, ?, ?)
    ON CONFLICT (folder_id, kind, target_id) DO UPDATE SET mode = excluded.mode
  `);
  for (const item of include ?? []) put.run(folderId, item.kind, item.id, 'include');
  for (const item of exclude ?? []) put.run(folderId, item.kind, item.id, 'exclude');
}

function isEmpty(folderId, types) {
  if (types) return false;
  return !db.prepare("SELECT 1 FROM chat_folder_items WHERE folder_id = ? AND mode = 'include'").get(folderId);
}

/* ─ Ручки ──────────────────────────────────────────────────────────────── */

router.get('/', (req, res) => {
  res.json({ folders: myFolders(req.user.id).map(serialize) });
});

router.post('/', (req, res, next) => {
  try {
    const me = req.user.id;
    if (myFolders(me).length >= FOLDER_LIMIT) {
      return res.status(400).json({ error: `Папок не больше ${FOLDER_LIMIT}` });
    }
    const f = readFolder(req.body);
    if (!f.types && !(f.include?.length)) {
      return res.status(400).json({ error: 'В папке должны быть виды чатов или хотя бы один чат' });
    }
    const top = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM chat_folders WHERE user_id = ?').get(me).p;

    db.exec('BEGIN');
    try {
      const info = db.prepare(`
        INSERT INTO chat_folders (user_id, title, position, types, exclude_muted, exclude_read, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(me, f.title, top + 1, f.types, f.excludeMuted, f.excludeRead, nowIso());
      writeItems(Number(info.lastInsertRowid), f.include, f.exclude);
      db.exec('COMMIT');
      const folder = db.prepare('SELECT * FROM chat_folders WHERE id = ?').get(Number(info.lastInsertRowid));
      res.status(201).json({ folder: serialize(folder) });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Порядок вкладок — полным списком id: так нельзя «потерять» папку или
 * поставить две на одно место. Объявлено раньше `/:id`.
 */
router.put('/order', (req, res, next) => {
  try {
    const me = req.user.id;
    const ids = req.body?.ids;
    const mine = myFolders(me).map((f) => f.id);
    if (!Array.isArray(ids) || ids.length !== mine.length || [...ids].sort((a, b) => a - b).join() !== [...mine].sort((a, b) => a - b).join()) {
      return res.status(400).json({ error: 'Порядок — полный список ваших папок' });
    }
    const move = db.prepare('UPDATE chat_folders SET position = ? WHERE id = ? AND user_id = ?');
    ids.forEach((id, position) => move.run(position, id, me));
    res.json({ folders: myFolders(me).map(serialize) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', (req, res, next) => {
  try {
    const folder = ownFolder(req, res);
    if (!folder) return;
    const f = readFolder(req.body, folder);

    db.exec('BEGIN');
    try {
      db.prepare('UPDATE chat_folders SET title = ?, types = ?, exclude_muted = ?, exclude_read = ? WHERE id = ?')
        .run(f.title, f.types, f.excludeMuted, f.excludeRead, folder.id);
      writeItems(folder.id, f.include, f.exclude);
      if (isEmpty(folder.id, f.types)) {
        db.exec('ROLLBACK');
        return res.status(400).json({ error: 'В папке должны быть виды чатов или хотя бы один чат' });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.json({ folder: serialize(db.prepare('SELECT * FROM chat_folders WHERE id = ?').get(folder.id)) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  const folder = ownFolder(req, res);
  if (!folder) return;
  db.prepare('DELETE FROM chat_folders WHERE id = ?').run(folder.id);
  res.json({ ok: true });
});
