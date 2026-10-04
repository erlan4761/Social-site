import { Router } from 'express';
import multer from 'multer';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { blockPairSql, isBlockedPair } from '../blocks.js';
import { deleteUpload, fileName, publicUrl, storeUpload } from '../media.js';
import { dropNotification, notify } from '../notifications.js';
import * as v from '../validate.js';

export const router = Router();

const PAGE_SIZE = 20;
const COMMENT_CAP = 500;

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
});

// Экспортируется вместе с POST_COLUMNS: /api/search/posts отдаёт те же посты,
// что и лента, и обязан отдавать их той же формы. Скопированная сериализация
// разошлась бы с этой на первом же новом поле.
export const serialize = (row) => ({
  id: row.id,
  body: row.body,
  createdAt: row.created_at,
  likeCount: row.like_count,
  commentCount: row.comment_count,
  likedByMe: Boolean(row.liked_by_me),
  // Закладка приватна: флаг всегда про смотрящего, а не про запись, и автору
  // о чужих закладках на его пост узнать неоткуда.
  bookmarkedByMe: Boolean(row.bookmarked_by_me),
  media: row.media_path
    ? { url: publicUrl('media', row.media_path), type: row.media_type, mime: row.media_mime, name: row.media_name }
    : null,
  author: {
    id: row.author_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: publicUrl('avatar', row.author_avatar_path),
  },
});

const serializeComment = (row) => ({
  id: row.id,
  postId: row.post_id,
  body: row.body,
  createdAt: row.created_at,
  // На какой комментарий ответ: клиент собирает из этого ветки.
  replyTo: row.reply_to_id
    ? { id: row.reply_to_id, author: { username: row.reply_username, displayName: row.reply_display_name } }
    : null,
  author: {
    id: row.author_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: publicUrl('avatar', row.author_avatar_path),
  },
});

// Counts live in subqueries rather than denormalised columns: one source of
// truth, and the per-post indexes keep it cheap at this scale.
//
// comment_count фильтруется блокировкой тем же условием, что и сам тред:
// иначе под постом стояло бы «5 комментариев», а разворачивалось три — и
// человек решил бы, что сайт сломан. like_count не фильтруется намеренно:
// это обезличенное число, по нему нельзя понять, кто лайкнул, а честный
// подсчёт стоил бы лишнего подзапроса на каждый пост ленты.
//
// bookmarked_by_me живёт здесь по той же причине, что и liked_by_me: одна
// колонка в одном месте — и флаг появляется разом в ленте, в отдельном посте,
// в поиске и в самом списке закладок. Цена — обязательный именованный
// параметр :viewerId в каждом запросе, который подставляет POST_COLUMNS
// (у гостя он NULL, и оба EXISTS честно дают 0).
export const POST_COLUMNS = `
  p.id, p.body, p.created_at, p.author_id, p.media_path, p.media_type, p.media_mime, p.media_name,
  u.username, u.display_name, u.avatar_path AS author_avatar_path,
  (SELECT COUNT(*) FROM likes    l WHERE l.post_id = p.id) AS like_count,
  (SELECT COUNT(*) FROM comments c
    WHERE c.post_id = p.id AND ${blockPairSql('c.author_id')}) AS comment_count,
  EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = :viewerId) AS liked_by_me,
  EXISTS(SELECT 1 FROM bookmarks bm WHERE bm.post_id = p.id AND bm.user_id = :viewerId) AS bookmarked_by_me
`;

/** Numeric route param, or null when it is not a usable id. */
function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// `YYYY` или `YYYY-MM`; месяц — только 01–12, иначе «2026-13» молча дал бы
// пустую ленту вместо внятного отказа.
const PERIOD_RE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;

/**
 * Период архива из query-строки.
 *
 * Мусорный период — это 400, в отличие от мусорного курсора, который просто
 * отдаёт первую страницу: курсор — служебная деталь пагинации, а период
 * человек видит в адресе, набирает руками и может исправить.
 *
 * Пустое значение (`?period=`) — не мусор, а снятый фильтр: так выглядит
 * адрес после кнопки «Показать всё», и отвечать на него ошибкой было бы
 * враньём.
 */
function periodParam(value) {
  if (value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (!PERIOD_RE.test(raw)) throw v.bad('Некорректный период');
  return raw;
}

/**
 * Feed, newest first. Keyset pagination on id: `cursor` is the id of the last
 * post already shown, so pages stay stable while new posts arrive at the top.
 *
 * `period` (`YYYY` или `YYYY-MM`) сужает ленту до года или месяца и работает
 * вместе с `author`, `feed` и `cursor`: архив в профиле — это та же лента,
 * а не отдельный эндпоинт со своей формой ответа.
 */
router.get('/', (req, res, next) => {
  try {
    const author = req.query.author ? String(req.query.author).toLowerCase() : null;
    const cursor = intParam(req.query.cursor);
    const period = periodParam(req.query.period);
    const onlyFollowing = req.query.feed === 'following';

    if (onlyFollowing && !req.user) {
      return res.status(401).json({ error: 'Войдите, чтобы смотреть подписки' });
    }

    const rows = db.prepare(`
      SELECT ${POST_COLUMNS}
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE (:author IS NULL OR u.username = :author)
        AND (:cursor IS NULL OR p.id < :cursor)
        AND ${blockPairSql('p.author_id')}
        AND (
          :onlyFollowing = 0
          OR p.author_id = :viewerId
          OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = :viewerId)
        )
        -- Одно условие на оба случая: длина самого периода решает, сравнивается
        -- год («2026») или месяц («2026-09»). created_at — ISO-строка в UTC,
        -- поэтому и границы месяца здесь по UTC (названо в README).
        AND (:period IS NULL OR substr(p.created_at, 1, length(:period)) = :period)
      ORDER BY p.id DESC
      LIMIT :limit
    `).all({
      author,
      cursor,
      period,
      viewerId: req.user?.id ?? null,
      onlyFollowing: onlyFollowing ? 1 : 0,
      limit: PAGE_SIZE + 1,
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);

    res.json({
      posts: page.map(serialize),
      nextCursor: hasMore ? page.at(-1).id : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Один пост — чтобы уведомление о лайке или комментарии вело на предмет
 * разговора, а не «примерно в профиль».
 *
 * Путь `/:id` состоит из одного сегмента и не перехватывает `/:id/comments`:
 * это разные маршруты, порядок объявления между ними роли не играет.
 */
router.get('/:id', (req, res) => {
  const id = intParam(req.params.id);
  // Ссылка с мусором вместо id — это не «плохой запрос», а несуществующий
  // пост: страница /p/<что угодно> должна показать одно и то же «не найдено».
  if (!id) return res.status(404).json({ error: 'Пост не найден' });

  const viewerId = req.user?.id ?? null;
  const row = db.prepare(`
    SELECT ${POST_COLUMNS}
    FROM posts p JOIN users u ON u.id = p.author_id
    WHERE p.id = :id AND ${blockPairSql('p.author_id')}
  `).get({ id, viewerId });

  // Пост автора, с которым смотрящий в блокировке, тоже «не найден»:
  // отдельный ответ выдал бы факт блокировки.
  if (!row) return res.status(404).json({ error: 'Пост не найден' });

  res.json({ post: serialize(row) });
});

router.post('/', requireAuth, mediaUpload.single('media'), async (req, res, next) => {
  let stored = null;
  try {
    const hasMedia = Boolean(req.file);

    // A post needs *something* — text or media — but not necessarily both,
    // matching how every mainstream feed treats a photo-only post.
    const body = hasMedia
      ? v.str(req.body?.body ?? '', 'текст поста', { max: 500 })
      : v.str(req.body?.body, 'текст поста', { min: 1, max: 500 });

    if (hasMedia) {
      stored = await storeUpload(req.file.buffer, { allowedKinds: ['image', 'video', 'audio'], into: 'media' });
    }

    const originalName = hasMedia ? v.str(fileName(req.file.originalname), 'имя файла', { max: 200 }) : null;

    const info = db.prepare(`
      INSERT INTO posts (author_id, body, media_path, media_type, media_mime, media_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, body, stored?.filename ?? null, stored?.kind ?? null, stored?.mime ?? null, originalName, nowIso());

    const row = db.prepare(`
      SELECT ${POST_COLUMNS}
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.id = :id
    `).get({ id: info.lastInsertRowid, viewerId: req.user.id });

    res.status(201).json({ post: serialize(row) });
  } catch (err) {
    // The file made it to disk but the post row didn't — don't leave an orphan.
    if (stored) deleteUpload('media', stored.filename);
    next(err);
  }
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Некорректный id' });

  const post = db.prepare('SELECT author_id, media_path FROM posts WHERE id = ?').get(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  if (post.author_id !== req.user.id) return res.status(403).json({ error: 'Это не ваш пост' });

  // Likes and comments go with it via ON DELETE CASCADE.
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  deleteUpload('media', post.media_path);
  res.json({ ok: true });
});

/* ─ Лайки ──────────────────────────────────────────────────────────────── */

const likeCount = (postId) =>
  db.prepare('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?').get(postId).c;

router.put('/:id/like', requireAuth, (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });

    const post = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(id);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });

    // Idempotent: liking twice is not an error, the row is simply already there.
    db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)')
      .run(req.user.id, id, nowIso());

    // Свой лайк, блокировка и повторное событие о том же посте отсеиваются
    // внутри notify() — здесь проверять нечего.
    notify({ userId: post.author_id, actorId: req.user.id, kind: 'like', postId: id });

    res.json({ likeCount: likeCount(id), likedByMe: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/like', requireAuth, (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });

    const post = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(id);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });

    db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, id);

    // Снятый лайк уносит непрочитанное событие о себе: иначе включение и
    // выключение лайка было бы способом дёргать человека бесконечно.
    dropNotification({ userId: post.author_id, actorId: req.user.id, kind: 'like', postId: id });

    res.json({ likeCount: likeCount(id), likedByMe: false });
  } catch (err) {
    next(err);
  }
});

/* ─ Закладки ───────────────────────────────────────────────────────────── */

/**
 * Сохранить запись.
 *
 * Уведомления здесь нет намеренно: закладка приватна, автор о ней знать не
 * должен — этим она и отличается от отметки.
 *
 * Запись автора, с которым смотрящий в блокировке, «не найдена» — тем же
 * ответом, что и несуществующая: отдельный текст выдал бы факт блокировки.
 */
router.put('/:id/bookmark', requireAuth, (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });

    const viewerId = req.user.id;
    const post = db.prepare(`
      SELECT 1 FROM posts p WHERE p.id = :id AND ${blockPairSql('p.author_id')}
    `).get({ id, viewerId });
    if (!post) return res.status(404).json({ error: 'Пост не найден' });

    // Идемпотентно на уровне схемы: UNIQUE (user_id, post_id) + OR IGNORE.
    // Повтор не создаёт вторую строку и, что важнее, не меняет id закладки —
    // иначе повторное нажатие поднимало бы старую запись наверх списка.
    db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)')
      .run(viewerId, id, nowIso());

    res.json({ bookmarkedByMe: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Снять закладку.
 *
 * Единственное место, где видимость записи НЕ проверяется, и это осознанно:
 * автора могли заблокировать уже после сохранения, и такая закладка выпадает
 * из списка (фильтр стоит на чтении), но строка в таблице остаётся. Требуй мы
 * здесь видимость, снять её было бы нечем — она застряла бы навсегда.
 * Ничего чужого при этом не удаляется: условие всегда включает свой user_id.
 */
router.delete('/:id/bookmark', requireAuth, (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });

    const post = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });

    // Несохранённая запись — не ошибка: DELETE идемпотентен так же, как PUT.
    db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').run(req.user.id, id);

    res.json({ bookmarkedByMe: false });
  } catch (err) {
    next(err);
  }
});

/* ─ Комментарии ────────────────────────────────────────────────────────── */

router.get('/:id/comments', (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Некорректный id' });

  const viewerId = req.user?.id ?? null;

  // Пост автора, с которым смотрящий в блокировке, «не найден» — ровно как в
  // GET /:id. Иначе тред остался бы дверью к скрытому посту.
  const exists = db.prepare(`
    SELECT 1 FROM posts p WHERE p.id = :id AND ${blockPairSql('p.author_id')}
  `).get({ id, viewerId });
  if (!exists) return res.status(404).json({ error: 'Пост не найден' });

  // Oldest first — a comment thread reads as a conversation, not as a feed.
  // Запрос переведён на именованные параметры целиком: blockPairSql() ждёт
  // :viewerId, а смешивать именованные с позиционными — лишний повод
  // ошибиться порядком.
  const rows = db.prepare(`
    SELECT c.id, c.post_id, c.body, c.created_at, c.author_id, c.reply_to_id,
           u.username, u.display_name, u.avatar_path AS author_avatar_path,
           ru.username AS reply_username, ru.display_name AS reply_display_name
    FROM comments c JOIN users u ON u.id = c.author_id
    LEFT JOIN comments rc ON rc.id = c.reply_to_id
    LEFT JOIN users ru ON ru.id = rc.author_id
    WHERE c.post_id = :id AND ${blockPairSql('c.author_id')}
    ORDER BY c.id ASC
    LIMIT :limit
  `).all({ id, viewerId, limit: COMMENT_CAP });

  res.json({ comments: rows.map(serializeComment) });
});

router.post('/:id/comments', requireAuth, (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });

    const post = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(id);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });

    // Читать чужой тред заблокированная пара всё равно не может (выше 404),
    // но запись под чужим постом закрывается отдельно: id поста мог остаться
    // у клиента с прошлой сессии.
    if (isBlockedPair(req.user.id, post.author_id)) {
      return res.status(403).json({ error: 'Комментировать этот пост нельзя' });
    }

    const body = v.str(req.body?.body, 'текст комментария', { min: 1, max: 300 });

    // Ответ — на комментарий этого же поста, видимый отвечающему: на реплику
    // того, с кем он в блокировке, ответить нельзя, её и не видно.
    let replied = null;
    if (req.body?.replyTo != null) {
      const replyId = Number(req.body.replyTo);
      replied = Number.isSafeInteger(replyId) && replyId > 0
        ? db.prepare('SELECT id, author_id FROM comments WHERE id = ? AND post_id = ?').get(replyId, id)
        : null;
      if (!replied || isBlockedPair(req.user.id, replied.author_id)) {
        return res.status(400).json({ error: 'Комментарий, на который вы отвечаете, не найден' });
      }
    }

    const info = db.prepare(
      'INSERT INTO comments (post_id, author_id, body, created_at, reply_to_id) VALUES (?, ?, ?, ?, ?)',
    ).run(id, req.user.id, body, nowIso(), replied?.id ?? null);

    // Комментарии не схлопываются и не дедуплицируются: каждый — отдельная
    // реплика, поэтому событие несёт и пост, и сам комментарий.
    notify({
      userId: post.author_id,
      actorId: req.user.id,
      kind: 'comment',
      postId: id,
      commentId: Number(info.lastInsertRowid),
    });
    // Тому, кому ответили, — своё событие; автор поста уже узнал из «comment».
    if (replied && replied.author_id !== post.author_id) {
      notify({
        userId: replied.author_id,
        actorId: req.user.id,
        kind: 'comment_reply',
        postId: id,
        commentId: Number(info.lastInsertRowid),
      });
    }

    const row = db.prepare(`
      SELECT c.id, c.post_id, c.body, c.created_at, c.author_id, c.reply_to_id,
             u.username, u.display_name, u.avatar_path AS author_avatar_path,
             ru.username AS reply_username, ru.display_name AS reply_display_name
      FROM comments c JOIN users u ON u.id = c.author_id
      LEFT JOIN comments rc ON rc.id = c.reply_to_id
      LEFT JOIN users ru ON ru.id = rc.author_id
      WHERE c.id = ?
    `).get(info.lastInsertRowid);

    res.status(201).json({ comment: serializeComment(row) });
  } catch (err) {
    next(err);
  }
});
