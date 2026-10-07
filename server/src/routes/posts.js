import { Router } from 'express';
import multer from 'multer';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { blockPairSql, isBlockedPair } from '../blocks.js';
import { deleteUpload, fileName, publicUrl, storeUpload } from '../media.js';
import { dropNotification, notify } from '../notifications.js';
import { notifyPostMentions } from '../postMentions.js';
import { tagFromParam, tagsIn } from '../hashtags.js';
import { canSeeAuthor, canSeeAuthorSql, isPrivate } from '../privacy.js';
import { clearPostDraft } from '../drafts.js';
import * as v from '../validate.js';

export const router = Router();

const PAGE_SIZE = 20;
const COMMENT_CAP = 500;

/** До десяти фото и видео в записи — как альбом в Телеграме; аудио — одно и отдельно. */
export const GALLERY_MAX = 10;

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: GALLERY_MAX },
});

/** Файлы всех снимков записей — до удаления строк: каскад файлов на диске не видит. */
export const galleryPaths = (postIds) =>
  postIds.length === 0
    ? []
    : db.prepare(`SELECT path FROM post_media WHERE post_id IN (${postIds.map(() => '?').join(', ')})`).all(...postIds).map((r) => r.path);

const mediaOf = (m) => ({ url: publicUrl('media', m.path), type: m.type, mime: m.mime ?? null, name: m.name ?? null });

// Экспортируется вместе с POST_COLUMNS: /api/search/posts отдаёт те же посты,
// что и лента, и обязан отдавать их той же формы. Скопированная сериализация
// разошлась бы с этой на первом же новом поле.
export const serialize = (row) => serializePost(row, 0);

/**
 * Чей пост пересказан: у чистого репоста — оригинал целиком (его отметки,
 * ответы и закладки — его, а не репоста), у цитаты — то, что цитируют.
 * Оригинал, автор которого с смотрящим в блокировке, или удалённый — `post: null`.
 * Глубина ограничена: репост цитаты покажет и процитированное, дальше — нет.
 */
function sharedOf(row, depth) {
  const id = row.repost_of_id ?? row.quote_of_id;
  if (!id) return null;
  const kind = row.repost_of_id ? 'repost' : 'quote';
  if (depth >= 2) return { kind, post: null };
  const original = db.prepare(`
    SELECT ${POST_COLUMNS}
    FROM posts p JOIN users u ON u.id = p.author_id
    WHERE p.id = :id AND ${POST_VISIBLE_SQL}
  `).get({ id, viewerId: row.viewer_id ?? null });
  return { kind, post: original ? serializePost(original, depth + 1) : null };
}

/**
 * Ветка — цепочка своих записей, каждая продолжает предыдущую. Для записи в ветке:
 * корень, номер и длина; у одиночной — null. Цепочки короткие и свои, поэтому
 * два рекурсивных запроса на запись в ветке — честная цена.
 */
function threadOf(row) {
  if (!row.continues_id && !row.next_id) return null;
  const up = db.prepare(`
    WITH RECURSIVE up(id, prev) AS (
      SELECT id, continues_id FROM posts WHERE id = ?
      UNION ALL SELECT p.id, p.continues_id FROM posts p JOIN up ON p.id = up.prev
    )
    SELECT COUNT(*) AS n, (SELECT id FROM up WHERE prev IS NULL) AS root FROM up
  `).get(row.id);
  const down = db.prepare(`
    WITH RECURSIVE down(id) AS (
      SELECT id FROM posts WHERE continues_id = ?
      UNION ALL SELECT p.id FROM posts p JOIN down ON p.continues_id = down.id
    )
    SELECT COUNT(*) AS n FROM down
  `).get(row.id);
  return {
    rootId: up.root ?? row.id,
    position: up.n,
    length: up.n + down.n,
    prevId: row.continues_id ?? null,
    nextId: row.next_id ?? null,
  };
}

const serializePost = (row, depth) => ({
  id: row.id,
  body: row.body,
  createdAt: row.created_at,
  editedAt: row.edited_at ?? null,
  likeCount: row.like_count,
  commentCount: row.comment_count,
  likedByMe: Boolean(row.liked_by_me),
  // Закладка приватна: флаг всегда про смотрящего, а не про запись, и автору
  // о чужих закладках на его пост узнать неоткуда.
  bookmarkedByMe: Boolean(row.bookmarked_by_me),
  media: row.media_path
    ? { url: publicUrl('media', row.media_path), type: row.media_type, mime: row.media_mime, name: row.media_name }
    : null,
  // Все снимки по порядку; у записи с одним снимком — он же, что и `media`.
  gallery: JSON.parse(row.gallery_json ?? '[]').map(mediaOf),
  // Репосты и цитаты вместе: обе — «поделились записью».
  repostCount: row.repost_count ?? 0,
  repostedByMe: Boolean(row.reposted_by_me),
  // Закреплена автором в профиле.
  pinned: Boolean(row.pinned),
  // Сколько человек видели запись — без самого автора.
  viewCount: row.view_count ?? 0,
  // Место в ветке: «2 из 3» и куда вести «вся ветка».
  thread: threadOf(row),
  shared: sharedOf(row, depth),
  author: {
    id: row.author_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: publicUrl('avatar', row.author_avatar_path),
    ...(row.author_private ? { private: true } : {}),
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
  p.id, p.body, p.created_at, p.edited_at, p.author_id, p.media_path, p.media_type, p.media_mime, p.media_name,
  p.repost_of_id, p.quote_of_id, p.continues_id, :viewerId AS viewer_id,
  (SELECT nx.id FROM posts nx WHERE nx.continues_id = p.id) AS next_id,
  u.username, u.display_name, u.avatar_path AS author_avatar_path, u.pinned_post_id IS p.id AS pinned, u.private AS author_private,
  (SELECT COUNT(*) FROM likes    l WHERE l.post_id = p.id) AS like_count,
  (SELECT COUNT(*) FROM comments c
    WHERE c.post_id = p.id AND ${blockPairSql('c.author_id')}) AS comment_count,
  EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = :viewerId) AS liked_by_me,
  EXISTS(SELECT 1 FROM bookmarks bm WHERE bm.post_id = p.id AND bm.user_id = :viewerId) AS bookmarked_by_me,
  (SELECT json_group_array(json_object('path', g.path, 'type', g.type, 'mime', g.mime, 'name', g.name))
     FROM (SELECT * FROM post_media pm WHERE pm.post_id = p.id ORDER BY pm.position) g) AS gallery_json,
  (SELECT COUNT(*) FROM posts rp WHERE rp.repost_of_id = p.id)
    + (SELECT COUNT(*) FROM posts qp WHERE qp.quote_of_id = p.id) AS repost_count,
  EXISTS(SELECT 1 FROM posts rp2 WHERE rp2.repost_of_id = p.id AND rp2.author_id = :viewerId) AS reposted_by_me,
  (SELECT COUNT(*) FROM post_views pvw WHERE pvw.post_id = p.id) AS view_count
`;

/** Видна ли запись смотрящему: не в блокировке и автор не закрыт от него. */
export const POST_VISIBLE_SQL = `${blockPairSql('p.author_id')} AND ${canSeeAuthorSql('p.author_id')}`;

/**
 * Чистый репост виден, только если виден оригинал: репост записи того, с кем
 * смотрящий в блокировке, был бы пустой рамкой — его просто нет в ленте.
 */
export const REPOST_VISIBLE_SQL = `(p.repost_of_id IS NULL OR EXISTS (
  SELECT 1 FROM posts o WHERE o.id = p.repost_of_id AND ${blockPairSql('o.author_id')} AND ${canSeeAuthorSql('o.author_id')}
))`;

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
    // Лента тега: `?tag=плёнка` (или «#Плёнка») — записи, где он стоит.
    const tag = req.query.tag != null ? tagFromParam(req.query.tag) : null;
    if (req.query.tag != null && !tag) throw v.bad('Некорректный тег');

    if (onlyFollowing && !req.user) {
      return res.status(401).json({ error: 'Войдите, чтобы смотреть подписки' });
    }

    const rows = db.prepare(`
      SELECT ${POST_COLUMNS}
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE (:author IS NULL OR u.username = :author)
        AND (:cursor IS NULL OR p.id < :cursor)
        AND ${POST_VISIBLE_SQL}
        AND ${REPOST_VISIBLE_SQL}
        AND (
          :onlyFollowing = 0
          OR p.author_id = :viewerId
          OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = :viewerId)
          -- И записи с тегами, за которыми смотрящий следит (routes/tags.js).
          OR EXISTS (
            SELECT 1 FROM post_tags ft JOIN tag_follows tf ON tf.tag = ft.tag AND tf.user_id = :viewerId
            WHERE ft.post_id = p.id
          )
        )
        -- Одно условие на оба случая: длина самого периода решает, сравнивается
        -- год («2026») или месяц («2026-09»). created_at — ISO-строка в UTC,
        -- поэтому и границы месяца здесь по UTC (названо в README).
        AND (:period IS NULL OR substr(p.created_at, 1, length(:period)) = :period)
        AND (:tag IS NULL OR EXISTS (SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag = :tag))
      ORDER BY p.id DESC
      LIMIT :limit
    `).all({
      author,
      cursor,
      period,
      tag,
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
    WHERE p.id = :id AND ${POST_VISIBLE_SQL} AND ${REPOST_VISIBLE_SQL}
  `).get({ id, viewerId });

  // Пост автора, с которым смотрящий в блокировке, тоже «не найден»:
  // отдельный ответ выдал бы факт блокировки.
  if (!row) return res.status(404).json({ error: 'Пост не найден' });

  res.json({ post: serialize(row) });
});

/**
 * Вся ветка, в которую входит запись, — от первой до последней. Записи одной
 * ветки — одного автора, поэтому видимость одна на всех: видна эта — видны все.
 */
router.get('/:id/thread', (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(404).json({ error: 'Пост не найден' });
  const viewerId = req.user?.id ?? null;
  const row = db.prepare(`
    SELECT ${POST_COLUMNS}
    FROM posts p JOIN users u ON u.id = p.author_id
    WHERE p.id = :id AND ${POST_VISIBLE_SQL} AND ${REPOST_VISIBLE_SQL}
  `).get({ id, viewerId });
  if (!row) return res.status(404).json({ error: 'Пост не найден' });
  const rootId = threadOf(row)?.rootId ?? row.id;
  const ids = db.prepare(`
    WITH RECURSIVE down(id, n) AS (
      SELECT ?, 0
      UNION ALL SELECT p.id, down.n + 1 FROM posts p JOIN down ON p.continues_id = down.id
    )
    SELECT id FROM down ORDER BY n
  `).all(rootId).map((r) => r.id);
  res.json({ posts: ids.map((x) => postById(x, viewerId)).filter(Boolean) });
});

router.post('/', requireAuth, mediaUpload.array('media', GALLERY_MAX), async (req, res, next) => {
  const stored = [];
  try {
    const files = req.files ?? [];
    const hasMedia = files.length > 0;

    // A post needs *something* — text or media — but not necessarily both,
    // matching how every mainstream feed treats a photo-only post.
    const body = hasMedia
      ? v.str(req.body?.body ?? '', 'текст поста', { max: 500 })
      : v.str(req.body?.body, 'текст поста', { min: 1, max: 500 });

    // Цитата: своя запись со ссылкой на чужую (или свою). Цитата репоста — цитата
    // оригинала: пересказывать пустую рамку незачем.
    let quoted = null;
    if (req.body?.quoteOf != null && req.body.quoteOf !== '') {
      const quoteId = intParam(String(req.body.quoteOf));
      quoted = quoteId ? visiblePost(quoteId, req.user.id) : null;
      if (quoted?.repost_of_id) quoted = visiblePost(quoted.repost_of_id, req.user.id);
      if (!quoted) return res.status(404).json({ error: 'Цитируемая запись не найдена' });
      if (isPrivate(quoted.author_id)) return res.status(403).json({ error: PRIVATE_SHARE_MESSAGE });
    }

    // Продолжение ветки: своя запись, не репост и ещё без продолжения — ветка
    // линейна, продолжают её последнюю запись.
    let continued = null;
    if (req.body?.continues != null && req.body.continues !== '') {
      const prevId = intParam(String(req.body.continues));
      continued = prevId ? db.prepare('SELECT id, author_id, repost_of_id FROM posts WHERE id = ?').get(prevId) : null;
      if (!continued) return res.status(404).json({ error: 'Запись для продолжения не найдена' });
      if (continued.author_id !== req.user.id) return res.status(403).json({ error: 'Продолжить можно только свою запись' });
      if (continued.repost_of_id) return res.status(400).json({ error: 'Репост не продолжить — продолжите свою запись' });
      if (db.prepare('SELECT 1 FROM posts WHERE continues_id = ?').get(continued.id)) {
        return res.status(409).json({ error: 'У записи уже есть продолжение — продолжите последнюю запись ветки' });
      }
    }

    // Несколько файлов — галерея: только фото и видео. Аудио — одно, само по себе.
    const names = files.map((f) => v.str(fileName(f.originalname), 'имя файла', { max: 200 }));
    for (const f of files) {
      stored.push(await storeUpload(f.buffer, { allowedKinds: files.length > 1 ? ['image', 'video'] : ['image', 'video', 'audio'], into: 'media' }));
    }
    const postId = insertPost({ authorId: req.user.id, body, stored, names, quoted, continuesId: continued?.id ?? null });
    // Запись из композера — его черновик исполнен. Цитата и продолжение ветки
    // пишутся в своих окнах.
    if (!quoted && !continued) clearPostDraft(req.user.id);
    res.status(201).json({ post: postById(postId, req.user.id) });
  } catch (err) {
    // Файлы уже на диске, а записи нет — сирот не оставляем.
    for (const s of stored) deleteUpload('media', s.filename);
    next(err);
  }
});

/**
 * Новая запись — одна дорога и для обычной, и для отложенной (scheduledPosts.js):
 * строка, снимки, теги, событие процитированному и упоминания.
 * Возвращает id записи.
 */
export function insertPost({ authorId, body, stored = [], names = [], quoted = null, continuesId = null }) {
  const first = stored[0] ?? null;
  const info = db.prepare(`
    INSERT INTO posts (author_id, body, media_path, media_type, media_mime, media_name, quote_of_id, continues_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(authorId, body, first?.filename ?? null, first?.kind ?? null, first?.mime ?? null, names[0] ?? null, quoted?.id ?? null, continuesId, nowIso());
  const postId = Number(info.lastInsertRowid);
  const insertMedia = db.prepare('INSERT INTO post_media (post_id, position, path, type, mime, name) VALUES (?, ?, ?, ?, ?, ?)');
  stored.forEach((s, i) => insertMedia.run(postId, i, s.filename, s.kind, s.mime, names[i]));
  setPostTags(postId, body);
  // Процитированному — «процитировал вашу запись»; упоминание его же в тексте
  // цитаты второго события не даёт.
  if (quoted) notify({ userId: quoted.author_id, actorId: authorId, kind: 'quote', postId });
  notifyPostMentions({ authorId, postId, body, skip: quoted ? [quoted.author_id] : [] });
  return postId;
}

/** Запись глазами смотрящего — та же форма, что в ленте. */
export function postById(id, viewerId) {
  const row = db.prepare(`
    SELECT ${POST_COLUMNS}
    FROM posts p JOIN users u ON u.id = p.author_id
    WHERE p.id = :id
  `).get({ id, viewerId });
  return row ? serialize(row) : null;
}

/**
 * Правка записи — только текста и только своей, двое суток, как у сообщений:
 * поправить опечатку можно, а переписать то, что неделю обсуждали в
 * комментариях, — уже подмена. Тот же текст пометку «изменено» не ставит.
 * Медиа не меняется: другой снимок — это другая запись.
 */
const EDIT_WINDOW_MS = 48 * 60 * 60_000;

router.patch('/:id', requireAuth, (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });
    const post = db.prepare('SELECT author_id, body, created_at, media_path, repost_of_id FROM posts WHERE id = ?').get(id);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    if (post.author_id !== req.user.id) return res.status(403).json({ error: 'Изменить можно только свою запись' });
    if (post.repost_of_id) return res.status(400).json({ error: 'Репост не правится — его можно только отменить' });
    if (Date.now() - Date.parse(post.created_at) > EDIT_WINDOW_MS) {
      return res.status(403).json({ error: 'Запись можно изменить только в течение 48 часов' });
    }

    // Те же правила, что при создании: запись со снимком может остаться без текста.
    const body = post.media_path
      ? v.str(req.body?.body ?? '', 'текст поста', { max: 500 })
      : v.str(req.body?.body, 'текст поста', { min: 1, max: 500 });
    if (body !== post.body) {
      db.prepare('UPDATE posts SET body = ?, edited_at = ? WHERE id = ?').run(body, nowIso(), id);
      setPostTags(id, body);
      notifyPostMentions({ authorId: req.user.id, postId: id, body, previousBody: post.body });
    }

    const row = db.prepare(`
      SELECT ${POST_COLUMNS}
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.id = :id
    `).get({ id, viewerId: req.user.id });
    res.json({ post: serialize(row) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Некорректный id' });

  const post = db.prepare('SELECT author_id, media_path, repost_of_id, continues_id FROM posts WHERE id = ?').get(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  if (post.author_id !== req.user.id) return res.status(403).json({ error: 'Это не ваш пост' });
  if (post.repost_of_id) {
    const original = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(post.repost_of_id);
    if (original) dropNotification({ userId: original.author_id, actorId: req.user.id, kind: 'repost', postId: post.repost_of_id });
  }

  // Likes, comments and gallery rows go with it via ON DELETE CASCADE; the
  // files on disk do not — collect them first.
  const files = galleryPaths([id]);
  // Удалили запись из середины ветки — следующая продолжает предыдущую:
  // ветка не рвётся на две.
  const next = db.prepare('SELECT id FROM posts WHERE continues_id = ?').get(id);
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  if (next && post.continues_id) db.prepare('UPDATE posts SET continues_id = ? WHERE id = ?').run(post.continues_id, next.id);
  for (const path of new Set([post.media_path, ...files])) deleteUpload('media', path);
  res.json({ ok: true });
});

/** Теги записи — заново целиком: при правке старые уходят, новые встают. */
function setPostTags(postId, body) {
  db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(postId);
  const insert = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag, label) VALUES (?, ?, ?)');
  for (const { tag, label } of tagsIn(body)) insert.run(postId, tag, label);
}

/* ─ Просмотры ─────────────────────────────────────────────────────────── */

/**
 * Просмотры пачкой: клиент присылает id записей, которые человек действительно
 * видел (на экране, а не просто загруженные), — до пятидесяти за раз. Один
 * человек — один просмотр записи; свои записи и те, что смотрящему не видны,
 * молча пропускаются: отказ по одной испортил бы всю пачку. Гостю счётчик не
 * набирается — его не отличить от обновления страницы.
 */
const VIEWS_BATCH_MAX = 50;

router.post('/views', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids || ids.length > VIEWS_BATCH_MAX) return res.status(400).json({ error: `ids — список до ${VIEWS_BATCH_MAX} записей` });
  const viewerId = req.user.id;
  const visible = db.prepare(`
    SELECT p.author_id FROM posts p
    WHERE p.id = :id AND p.repost_of_id IS NULL AND ${POST_VISIBLE_SQL}
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO post_views (post_id, user_id) VALUES (?, ?)');
  let counted = 0;
  for (const raw of new Set(ids)) {
    const id = intParam(String(raw));
    if (!id) continue;
    const post = visible.get({ id, viewerId });
    if (!post || post.author_id === viewerId) continue;
    counted += Number(insert.run(id, viewerId).changes);
  }
  res.json({ counted });
});

/* ─ Закреплённая запись ────────────────────────────────────────────────── */

/**
 * Закрепить в профиле: одна запись, своя и не репост — пустая рамка наверху
 * профиля ничего не скажет о человеке. Новое закрепление заменяет старое;
 * повторное — не ошибка. Снять можно только то, что закреплено.
 */
router.put('/:id/pin', requireAuth, (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Некорректный id' });
  const post = db.prepare('SELECT author_id, repost_of_id FROM posts WHERE id = ?').get(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  if (post.author_id !== req.user.id) return res.status(403).json({ error: 'Закрепить можно только свою запись' });
  if (post.repost_of_id) return res.status(400).json({ error: 'Репост не закрепить — закрепите свою запись' });
  db.prepare('UPDATE users SET pinned_post_id = ? WHERE id = ?').run(id, req.user.id);
  res.json({ pinned: true });
});

router.delete('/:id/pin', requireAuth, (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Некорректный id' });
  db.prepare('UPDATE users SET pinned_post_id = NULL WHERE id = ? AND pinned_post_id = ?').run(req.user.id, id);
  res.json({ pinned: false });
});

/* ─ Репосты ────────────────────────────────────────────────────────────── */

/** Записи закрытого профиля не расходятся дальше его подписчиков — ни репостом, ни цитатой. */
const PRIVATE_SHARE_MESSAGE = 'Записи закрытого профиля нельзя репостить и цитировать';

/** Запись, которую смотрящий видит: нет её, автор с ним в блокировке или закрыт от него — null. */
function visiblePost(id, viewerId) {
  return db.prepare(`
    SELECT p.id, p.author_id, p.repost_of_id FROM posts p
    WHERE p.id = :id AND ${POST_VISIBLE_SQL}
  `).get({ id, viewerId }) ?? null;
}

const repostState = (postId, viewerId) => db.prepare(`
  SELECT (SELECT COUNT(*) FROM posts WHERE repost_of_id = :postId)
       + (SELECT COUNT(*) FROM posts WHERE quote_of_id = :postId) AS repostCount,
         EXISTS(SELECT 1 FROM posts WHERE repost_of_id = :postId AND author_id = :viewerId) AS mine
`).get({ postId, viewerId });

/**
 * Репост — переключатель, как отметка: PUT ставит (повторный — не ошибка),
 * DELETE снимает. Репост репоста — репост оригинала. Отменённый репост уносит
 * непрочитанное событие о себе, а повторный нового не создаёт.
 */
router.put('/:id/repost', requireAuth, (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });
    let target = visiblePost(id, req.user.id);
    if (target?.repost_of_id) target = visiblePost(target.repost_of_id, req.user.id);
    if (!target) return res.status(404).json({ error: 'Пост не найден' });
    if (isPrivate(target.author_id)) return res.status(403).json({ error: PRIVATE_SHARE_MESSAGE });

    db.prepare("INSERT OR IGNORE INTO posts (author_id, body, repost_of_id, created_at) VALUES (?, '', ?, ?)")
      .run(req.user.id, target.id, nowIso());
    notify({ userId: target.author_id, actorId: req.user.id, kind: 'repost', postId: target.id });

    const state = repostState(target.id, req.user.id);
    res.json({ postId: target.id, repostCount: state.repostCount, repostedByMe: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/repost', requireAuth, (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });
    let target = db.prepare('SELECT id, author_id, repost_of_id FROM posts WHERE id = ?').get(id);
    if (target?.repost_of_id) target = db.prepare('SELECT id, author_id, repost_of_id FROM posts WHERE id = ?').get(target.repost_of_id);
    if (!target) return res.status(404).json({ error: 'Пост не найден' });

    db.prepare('DELETE FROM posts WHERE repost_of_id = ? AND author_id = ?').run(target.id, req.user.id);
    dropNotification({ userId: target.author_id, actorId: req.user.id, kind: 'repost', postId: target.id });

    const state = repostState(target.id, req.user.id);
    res.json({ postId: target.id, repostCount: state.repostCount, repostedByMe: false });
  } catch (err) {
    next(err);
  }
});

/* ─ Лайки ──────────────────────────────────────────────────────────────── */

const likeCount = (postId) =>
  db.prepare('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?').get(postId).c;

router.put('/:id/like', requireAuth, (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });

    const post = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(id);
    if (!post || !canSeeAuthor(req.user.id, post.author_id)) return res.status(404).json({ error: 'Пост не найден' });

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
      SELECT 1 FROM posts p WHERE p.id = :id AND ${POST_VISIBLE_SQL}
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
    SELECT 1 FROM posts p WHERE p.id = :id AND ${POST_VISIBLE_SQL}
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
    if (!post || !canSeeAuthor(req.user.id, post.author_id)) return res.status(404).json({ error: 'Пост не найден' });

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
    notifyPostMentions({
      authorId: req.user.id,
      postId: id,
      commentId: Number(info.lastInsertRowid),
      body,
      skip: [post.author_id, replied?.author_id].filter((x) => x != null),
    });

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
