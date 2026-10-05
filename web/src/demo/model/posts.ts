import { type Comment, type Post, type User } from '../../api';
import { type DbUser, type DbPost, type DbComment, db } from '../store';
import { byId, author, hidden, visiblePosts } from './people';

/** Записи, комментарии и поиск по ним — как posts.js и search.js. */

// ─ Поиск по записям ─────────────────────────────────────────────────────────

/**
 * `ё` сворачивается в `е` руками — и в запросе, и в тексте записи. На сервере
 * это делает `replace()` в триггере индекса: токенизатор FTS5 кириллическое `ё`
 * не трогает, а человек, который ищет «пленка», не должен промахиваться мимо
 * «плёнки». Замена посимвольная, длина строки не меняется.
 */
export const foldSearchText = (value: string) => value.replace(/ё/g, 'е').replace(/Ё/g, 'Е');

/** Разбор строки на слова — той же границей, что и токенизатор `unicode61`. */
export const wordsOf = (value: string) =>
  foldSearchText(value).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 0);

/** Термы запроса: не больше восьми, как потолок `ftsQuery()` на сервере. */
export const searchTerms = (raw: string) => wordsOf(raw).slice(0, 8);

/**
 * Совпадение по **началу** слова, а не по словоформе: русского стеммера в
 * SQLite нет, и сервер ищет префиксом (`"проявк"*`). Термы соединяются через
 * И — набравший два слова ждёт записи, где есть оба.
 */
export const matchesTerms = (body: string, terms: string[]) => {
  const words = wordsOf(body);
  return terms.every((term) => words.some((word) => word.startsWith(term)));
};

export const visibleComments = (postId: number) =>
  db.comments.filter((c) => c.postId === postId && !hidden(c.authorId));

export const publicUser = (u: DbUser): User => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  bio: u.bio,
  avatarUrl: u.avatarUrl,
  createdAt: u.createdAt,
  // Счётчик записей учитывает блокировку: «12 записей» над пустой лентой
  // выглядели бы поломкой сайта, а не следствием собственного решения.
  postCount: visiblePosts().filter((p) => p.authorId === u.id).length,
  followerCount: db.follows.filter((f) => f.followeeId === u.id).length,
  followingCount: db.follows.filter((f) => f.followerId === u.id).length,
  followedByMe: db.follows.some((f) => f.followerId === db.meId && f.followeeId === u.id),
});

export const toPost = (p: DbPost): Post => ({
  id: p.id,
  body: p.body,
  createdAt: p.createdAt,
  editedAt: p.editedAt ?? null,
  likeCount: db.likes.filter((l) => l.postId === p.id).length,
  // Комментарии фильтруются блокировкой, значит и счётчик под записью — тоже,
  // иначе он разошёлся бы с длиной видимой ветки. Лайки не фильтруем: это
  // обезличенное число.
  commentCount: visibleComments(p.id).length,
  likedByMe: db.likes.some((l) => l.postId === p.id && l.userId === db.meId),
  bookmarkedByMe: db.bookmarks.some((b) => b.postId === p.id && b.userId === db.meId),
  media: p.media,
  gallery: p.gallery ?? (p.media ? [p.media] : []),
  author: author(byId(p.authorId)!),
});

export const toComment = (c: DbComment): Comment => {
  const replied = c.replyToId != null ? db.comments.find((x) => x.id === c.replyToId) : undefined;
  const who = replied ? byId(replied.authorId) : undefined;
  return {
    id: c.id,
    postId: c.postId,
    body: c.body,
    createdAt: c.createdAt,
    author: author(byId(c.authorId)!),
    // Удалённый исходный — ответ больше не ответ, как SET NULL на сервере.
    replyTo: replied && who ? { id: replied.id, author: { username: who.username, displayName: who.displayName } } : null,
  };
};

export const PAGE = 20;

/** `YYYY` или `YYYY-MM` — та же проверка, что и на сервере. */
export const PERIOD_RE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;

/** Ответ поиска: `query` возвращается обратно, чтобы экран знал, что подсвечивать. */
export type SearchPage = { posts: Post[]; nextCursor: number | null; query: string };
