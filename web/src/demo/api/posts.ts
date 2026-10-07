import { type ArchiveMonth, type Page, type TagStat } from '../../api';
import { tagFromParam, tagsIn } from '../../hashtags';
import { type DbPost, type DbComment, db, id, tick, fail } from '../store';
import { byId, byName, me, requireMe, hidden, postHidden, canSeeAuthor, visiblePosts } from '../model/people';
import { searchTerms, matchesTerms, visibleComments, toPost, toComment, repostCountOf, threadOfPost, PAGE, PERIOD_RE, type SearchPage } from '../model/posts';
import { notify, dropNotification } from '../model/notifications';

/** Методы витрины: лента, записи, комментарии, поиск, архив, закладки. */

/** Упоминания в ленте — как notifyPostMentions() на сервере: новые, не больше десяти, без уже уведомлённых. */
const NAMES_RE = /(^|[^\p{L}\p{N}_@])@([a-z0-9_]{3,20})(?![a-z0-9_])/giu;
const namesIn = (text: string) => new Set([...text.matchAll(NAMES_RE)].map((m) => m[2].toLowerCase()));
function notifyPostMentions(input: { authorId: number; postId: number; commentId?: number; body: string; previousBody?: string; skip?: (number | undefined)[] }) {
  const before = input.previousBody == null ? new Set<string>() : namesIn(input.previousBody);
  const names = [...namesIn(input.body)].filter((n) => !before.has(n)).slice(0, 10);
  for (const name of names) {
    const target = byName(name);
    if (!target || input.skip?.includes(target.id)) continue;
    const postAuthor = db.posts.find((x) => x.id === input.postId)?.authorId ?? input.authorId;
    if (!canSeeAuthor(target.id, postAuthor)) continue;
    notify({ userId: target.id, actorId: input.authorId, kind: 'post_mention', postId: input.postId, commentId: input.commentId });
  }
}

/** Отложенная запись выходит — тем же путём, что обычная: теги из текста, упоминания. */
type DbScheduledPost = (typeof db.scheduledPosts)[number];
function publishScheduled(s: DbScheduledPost) {
  db.scheduledPosts = db.scheduledPosts.filter((x) => x.id !== s.id);
  const author = db.users.find((u) => u.id === s.authorId);
  if (!author || author.bannedAt) return null;
  const post: DbPost = { id: id(), authorId: s.authorId, body: s.body, createdAt: new Date().toISOString(), media: null, gallery: [] };
  db.posts.push(post);
  notifyPostMentions({ authorId: s.authorId, postId: post.id, body: s.body });
  return post;
}

/** Такт планировщика витрины — как publishDuePosts() на сервере. */
export function publishDuePosts() {
  const now = new Date().toISOString();
  for (const s of db.scheduledPosts.filter((x) => x.sendAt <= now)) publishScheduled(s);
}

function readPostSendAt(raw: Date) {
  const at = raw.getTime();
  if (Number.isNaN(at)) fail(400, 'Время публикации — дата в формате ISO');
  if (at <= Date.now()) fail(400, 'Время публикации уже прошло');
  if (at - Date.now() > 365 * 864e5) fail(400, 'Отложить можно не больше чем на год');
  return raw.toISOString();
}

const ownScheduled = (scheduledId: number) => {
  const u = requireMe()!;
  const s = db.scheduledPosts.find((x) => x.id === scheduledId && x.authorId === u.id);
  if (!s) fail(404, 'Отложенная запись не найдена');
  return s!;
};

const scheduledView = (s: DbScheduledPost) => ({ id: s.id, body: s.body, sendAt: s.sendAt, createdAt: s.createdAt });

const postDraftView = (userId: number) => {
  const d = db.postDrafts.find((x) => x.userId === userId);
  return d ? { body: d.body, updatedAt: d.updatedAt } : null;
};
const clearPostDraft = (userId: number) => {
  db.postDrafts = db.postDrafts.filter((x) => x.userId !== userId);
};

export const postsApi = {
  // Черновик записи — как /api/drafts/post: пустой убирает, лимит — как у записи.
  postDraft: () => tick({ draft: postDraftView(requireMe()!.id) }),

  savePostDraft: (text: string) => {
    const u = requireMe()!;
    if (text.length > 500) fail(400, '«черновик»: максимум 500 символов');
    clearPostDraft(u.id);
    if (text.trim()) db.postDrafts.push({ userId: u.id, body: text, updatedAt: new Date().toISOString() });
    return tick({ draft: postDraftView(u.id) });
  },

  // Те же правила, что POST /api/posts/views: свои, репосты и невидимые — мимо.
  recordViews: (ids: number[]) => {
    const u = requireMe()!;
    if (!Array.isArray(ids) || ids.length > 50) fail(400, 'ids — список до 50 записей');
    let counted = 0;
    for (const postId of new Set(ids)) {
      const p = visiblePosts().find((x) => x.id === postId);
      if (!p || p.repostOf != null || p.authorId === u.id) continue;
      if (db.postViews.some((v) => v.postId === postId && v.userId === u.id)) continue;
      db.postViews.push({ postId, userId: u.id, createdAt: new Date().toISOString() });
      counted += 1;
    }
    return tick({ counted });
  },

  // Статистика — как GET /api/posts/:id/stats: только автору, по дням с публикации, не больше двух недель.
  postStats: (postId: number) => {
    const u = requireMe()!;
    const p = db.posts.find((x) => x.id === postId);
    if (!p) fail(404, 'Пост не найден');
    if (p!.authorId !== u.id) fail(403, 'Статистика видна только автору');
    if (p!.repostOf != null) fail(400, 'У репоста нет своей статистики — она у оригинала');
    const views = db.postViews.filter((v) => v.postId === postId);
    const followers = new Set(db.follows.filter((f) => f.followeeId === u.id).map((f) => f.followerId));
    const likes = db.likes.filter((l) => l.postId === postId).length;
    const comments = db.comments.filter((c) => c.postId === postId).length;
    const reposts = db.posts.filter((x) => x.repostOf === postId).length;
    const quotes = db.posts.filter((x) => x.quoteOf === postId).length;
    const bookmarks = db.bookmarks.filter((b) => b.postId === postId).length;
    const today = Date.parse(new Date().toISOString().slice(0, 10));
    const start = Math.max(Date.parse(p!.createdAt.slice(0, 10)), today - 13 * 864e5);
    const byDay = [];
    for (let d = start; d <= today; d += 864e5) {
      const day = new Date(d).toISOString().slice(0, 10);
      byDay.push({ day, views: views.filter((v) => v.createdAt?.slice(0, 10) === day).length });
    }
    return tick({
      stats: {
        views: views.length,
        fromFollowers: views.filter((v) => followers.has(v.userId)).length,
        likes, comments, reposts, quotes, bookmarks,
        engagement: views.length > 0 ? Math.min(1, (likes + comments + reposts + quotes) / views.length) : null,
        byDay,
      },
    });
  },

  scheduledPosts: () => {
    const u = requireMe()!;
    publishDuePosts();
    return tick({ scheduled: db.scheduledPosts.filter((s) => s.authorId === u.id).sort((a, b) => a.sendAt.localeCompare(b.sendAt)).map(scheduledView) });
  },

  schedulePost: (text: string, sendAt: Date) => {
    const u = requireMe()!;
    const body = text.trim();
    if (!body) fail(400, '«текст поста»: минимум 1 символов');
    if (body.length > 500) fail(400, '«текст поста»: максимум 500 символов');
    const at = readPostSendAt(sendAt);
    if (db.scheduledPosts.filter((s) => s.authorId === u.id).length >= 50) fail(400, 'Отложенных записей не больше 50');
    const s = { id: id(), authorId: u.id, body, sendAt: at, createdAt: new Date().toISOString() };
    db.scheduledPosts.push(s);
    clearPostDraft(u.id);
    return tick({ scheduled: scheduledView(s) });
  },

  reschedulePost: (scheduledId: number, sendAt: Date) => {
    const s = ownScheduled(scheduledId);
    s.sendAt = readPostSendAt(sendAt);
    return tick({ scheduled: scheduledView(s) });
  },

  cancelScheduledPost: (scheduledId: number) => {
    const s = ownScheduled(scheduledId);
    db.scheduledPosts = db.scheduledPosts.filter((x) => x.id !== s.id);
    return tick({ ok: true as const });
  },

  publishScheduledPost: (scheduledId: number) => {
    const post = publishScheduled(ownScheduled(scheduledId));
    if (!post) fail(404, 'Отложенная запись не найдена');
    return tick({ post: toPost(post!) });
  },

  posts: (opts: { author?: string; cursor?: number | null; feed?: 'following'; period?: string; tag?: string } = {}) => {
    publishDuePosts();
    // Блокировка — главный фильтр ленты: и общей, и «по подпискам», и профильной.
    let list = visiblePosts().sort((a, b) => b.id - a.id);

    if (opts.tag != null) {
      const tag = tagFromParam(opts.tag);
      if (!tag) fail(400, 'Некорректный тег');
      list = list.filter((p) => tagsIn(p.body).some((x) => x.tag === tag));
    }

    if (opts.period != null) {
      // Мусорный период — 400, в отличие от мусорного курсора: период человек
      // видит в адресе строки и может его исправить.
      if (!PERIOD_RE.test(opts.period)) fail(400, 'Некорректный период');
      // Границы месяца по UTC: в базе лежит ISO-время в UTC, и сравнение
      // префикса строки — ровно то же, что `substr(created_at, 1, length(:period))`.
      list = list.filter((p) => p.createdAt.slice(0, opts.period!.length) === opts.period);
    }
    if (opts.author) {
      const u = byName(opts.author);
      list = u ? list.filter((p) => p.authorId === u.id) : [];
    }
    if (opts.feed === 'following') {
      if (!me()) fail(401, 'Войдите, чтобы смотреть подписки');
      const mine = db.follows.filter((f) => f.followerId === db.meId).map((f) => f.followeeId);
      // И записи с тегами, за которыми человек следит.
      const tags = new Set(db.tagFollows.filter((f) => f.userId === db.meId).map((f) => f.tag));
      list = list.filter((p) => p.authorId === db.meId || mine.includes(p.authorId) || tagsIn(p.body).some((x) => tags.has(x.tag)));
    }
    if (opts.cursor != null) list = list.filter((p) => p.id < opts.cursor!);

    const page = list.slice(0, PAGE);
    const result: Page = {
      posts: page.map(toPost),
      nextCursor: list.length > PAGE ? page.at(-1)!.id : null,
    };
    return tick(result);
  },

  createPost: (text: string, media?: File | File[] | null, quoteOf?: number | null, continues?: number | null) => {
    const u = requireMe()!;
    // Продолжение ветки — как на сервере: своя, не репост, без продолжения.
    let continued: DbPost | undefined;
    if (continues != null) {
      continued = db.posts.find((x) => x.id === continues);
      if (!continued) fail(404, 'Запись для продолжения не найдена');
      if (continued!.authorId !== u.id) fail(403, 'Продолжить можно только свою запись');
      if (continued!.repostOf != null) fail(400, 'Репост не продолжить — продолжите свою запись');
      if (db.posts.some((x) => x.continuesId === continues)) fail(409, 'У записи уже есть продолжение — продолжите последнюю запись ветки');
    }
    // Цитата репоста — цитата оригинала, как на сервере.
    let quoted: DbPost | undefined;
    if (quoteOf != null) {
      quoted = db.posts.find((x) => x.id === quoteOf);
      if (quoted?.repostOf != null) quoted = db.posts.find((x) => x.id === quoted!.repostOf);
      if (!quoted || postHidden(quoted)) fail(404, 'Цитируемая запись не найдена');
      if (byId(quoted!.authorId)?.private) fail(403, 'Записи закрытого профиля нельзя репостить и цитировать');
    }
    const files = media == null ? [] : Array.isArray(media) ? media : [media];
    const body = text.trim();
    if (!body && files.length === 0) fail(400, '«текст поста»: минимум 1 символов');
    if (body.length > 500) fail(400, '«текст поста»: максимум 500 символов');
    if (files.length > 10) fail(400, 'Слишком много файлов — в записи не больше десяти');
    if (files.length > 1 && files.some((f) => f.type.startsWith('audio/'))) fail(400, 'В галерее — только фото и видео');

    // objectURL живёт, пока открыта вкладка — ровно столько же, сколько демо.
    const gallery = files.map((f) => ({
      url: URL.createObjectURL(f),
      type: (f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'image') as 'image' | 'video' | 'audio',
      mime: f.type,
      name: f.name,
    }));
    const p: DbPost = {
      id: id(), authorId: u.id, body, createdAt: new Date().toISOString(),
      media: gallery[0] ?? null,
      gallery,
      quoteOf: quoted?.id ?? null,
      continuesId: continued?.id ?? null,
    };
    db.posts.push(p);
    // Запись из композера — черновик исполнен; цитата и продолжение — в своих окнах.
    if (!quoted && !continued) clearPostDraft(u.id);
    if (quoted) notify({ userId: quoted.authorId, actorId: u.id, kind: 'quote', postId: p.id });
    notifyPostMentions({ authorId: u.id, postId: p.id, body, skip: quoted ? [quoted.authorId] : [] });
    return tick({ post: toPost(p) });
  },

  updatePost: (postId: number, text: string) => {
    const before = db.posts.find((x) => x.id === postId)?.body ?? '';
    const u = requireMe()!;
    const p = db.posts.find((x) => x.id === postId);
    if (!p) fail(404, 'Пост не найден');
    if (p!.authorId !== u.id) fail(403, 'Изменить можно только свою запись');
    if (p!.repostOf != null) fail(400, 'Репост не правится — его можно только отменить');
    if (Date.now() - Date.parse(p!.createdAt) > 48 * 60 * 60_000) fail(403, 'Запись можно изменить только в течение 48 часов');
    const body = text.trim();
    if (!body && !p!.media) fail(400, '«текст поста»: минимум 1 символов');
    if (body.length > 500) fail(400, '«текст поста»: максимум 500 символов');
    if (body !== p!.body) {
      p!.body = body;
      p!.editedAt = new Date().toISOString();
      notifyPostMentions({ authorId: u.id, postId, body, previousBody: before });
    }
    return tick({ post: toPost(p!) });
  },

  deletePost: (postId: number) => {
    const u = requireMe()!;
    const p = db.posts.find((x) => x.id === postId);
    if (!p) fail(404, 'Пост не найден');
    if (p!.authorId !== u.id) fail(403, 'Это не ваш пост');
    // Удалённый свой репост уносит непрочитанное событие о себе.
    const original = p!.repostOf != null ? db.posts.find((x) => x.id === p!.repostOf) : undefined;
    if (original) dropNotification({ userId: original.authorId, actorId: u.id, kind: 'repost', postId: original.id });
    // Репосты уходят вместе с оригиналом — каскад repost_of_id; цитаты остаются.
    const gone = new Set([postId, ...db.posts.filter((x) => x.repostOf === postId).map((x) => x.id)]);
    // Удалили середину ветки — следующая продолжает предыдущую.
    const nextInThread = db.posts.find((x) => x.continuesId === postId);
    if (nextInThread) nextInThread.continuesId = p!.continuesId ?? null;
    // Закрепление снимается само — ON DELETE SET NULL.
    if (u.pinnedPostId != null && gone.has(u.pinnedPostId)) u.pinnedPostId = null;
    db.posts = db.posts.filter((x) => !gone.has(x.id));
    db.comments = db.comments.filter((c) => !gone.has(c.postId));
    db.likes = db.likes.filter((l) => !gone.has(l.postId));
    db.bookmarks = db.bookmarks.filter((b) => !gone.has(b.postId));
    // События о записи ведут туда, где больше ничего нет — каскад, как в схеме.
    db.notifications = db.notifications.filter((n) => n.postId == null || !gone.has(n.postId));
    return tick({ ok: true as const });
  },

  followedTags: () => {
    const u = requireMe()!;
    const tags = db.tagFollows
      .filter((f) => f.userId === u.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((f) => {
        const labels = visiblePosts().flatMap((p) => tagsIn(p.body).filter((x) => x.tag === f.tag).map((x) => x.label));
        return { tag: f.tag, label: labels.reduce((best, l) => (l > best ? l : best), labels[0] ?? f.tag) };
      });
    return tick({ tags });
  },

  setTagFollow: (raw: string, on: boolean) => {
    const u = requireMe()!;
    const tag = tagFromParam(raw);
    if (!tag) fail(400, 'Некорректный тег');
    db.tagFollows = db.tagFollows.filter((f) => !(f.userId === u.id && f.tag === tag));
    if (on) db.tagFollows.push({ userId: u.id, tag: tag!, createdAt: new Date().toISOString() });
    return tick({ followedByMe: on });
  },

  // Таблицы тегов у витрины нет: теги считаются из текста на лету — записей мало.
  trendingTags: () => {
    const since = Date.now() - 7 * 24 * 60 * 60_000;
    const stats = new Map<string, TagStat>();
    for (const p of visiblePosts()) {
      if (Date.parse(p.createdAt) < since) continue;
      for (const { tag, label } of tagsIn(p.body)) {
        const s = stats.get(tag) ?? { tag, label, count: 0 };
        s.count += 1;
        if (label > s.label) s.label = label;
        stats.set(tag, s);
      }
    }
    const tags = [...stats.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 10);
    return tick({ tags });
  },

  tagInfo: (raw: string) => {
    const tag = tagFromParam(raw);
    if (!tag) fail(400, 'Некорректный тег');
    const labels = visiblePosts().flatMap((p) => tagsIn(p.body).filter((x) => x.tag === tag).map((x) => x.label));
    // Подпись — «старшая» строка, как MAX(label) на сервере: написание с «ё» побеждает.
    const label = labels.reduce((best, l) => (l > best ? l : best), labels[0] ?? raw.replace(/^#/, '').toLowerCase());
    const followedByMe = db.tagFollows.some((f) => f.userId === db.meId && f.tag === tag);
    return tick({ tag: tag!, label, count: labels.length, followedByMe });
  },

  setPin: (postId: number, on: boolean) => {
    const u = requireMe()!;
    const p = db.posts.find((x) => x.id === postId);
    if (!p) fail(404, 'Пост не найден');
    if (p!.authorId !== u.id) fail(403, 'Закрепить можно только свою запись');
    if (on && p!.repostOf != null) fail(400, 'Репост не закрепить — закрепите свою запись');
    if (on) u.pinnedPostId = postId;
    else if (u.pinnedPostId === postId) u.pinnedPostId = null;
    return tick({ pinned: on });
  },

  setRepost: (postId: number, on: boolean) => {
    const u = requireMe()!;
    let target = db.posts.find((x) => x.id === postId);
    if (target?.repostOf != null) target = db.posts.find((x) => x.id === target!.repostOf);
    if (!target || (on && postHidden(target))) fail(404, 'Пост не найден');
    const original = target!;
    if (on && byId(original.authorId)?.private) fail(403, 'Записи закрытого профиля нельзя репостить и цитировать');
    const existing = db.posts.find((x) => x.repostOf === original.id && x.authorId === u.id);
    const event = { userId: original.authorId, actorId: u.id, kind: 'repost' as const, postId: original.id };
    if (on) {
      if (!existing) db.posts.push({ id: id(), authorId: u.id, body: '', createdAt: new Date().toISOString(), media: null, repostOf: original.id });
      notify(event);
    } else {
      if (existing) db.posts = db.posts.filter((x) => x !== existing);
      dropNotification(event);
    }
    return tick({ postId: original.id, repostCount: repostCountOf(original.id), repostedByMe: on });
  },

  setLike: (postId: number, liked: boolean) => {
    const u = requireMe()!;
    const liked0 = db.posts.find((x) => x.id === postId);
    if (!liked0 || !canSeeAuthor(u.id, liked0.authorId)) fail(404, 'Пост не найден');
    db.likes = db.likes.filter((l) => !(l.postId === postId && l.userId === u.id));
    if (liked) db.likes.push({ userId: u.id, postId });

    const p = db.posts.find((x) => x.id === postId);
    if (p) {
      const event = { userId: p.authorId, actorId: u.id, kind: 'like' as const, postId };
      if (liked) notify(event);
      else dropNotification(event);
    }

    return tick({ likeCount: db.likes.filter((l) => l.postId === postId).length, likedByMe: liked });
  },

  comments: (postId: number) => {
    // Ветка под скрытой записью была бы дверью к ней самой.
    const p = db.posts.find((x) => x.id === postId);
    if (p && postHidden(p)) fail(404, 'Пост не найден');
    return tick({ comments: visibleComments(postId).sort((a, b) => a.id - b.id).map(toComment) });
  },

  addComment: (postId: number, text: string, replyTo?: number | null) => {
    const u = requireMe()!;
    const body = text.trim();
    if (!body) fail(400, '«текст комментария»: минимум 1 символов');
    if (body.length > 300) fail(400, '«текст комментария»: максимум 300 символов');

    const p = db.posts.find((x) => x.id === postId);
    if (p && !canSeeAuthor(u.id, p.authorId)) fail(404, 'Пост не найден');
    if (p && hidden(p.authorId)) fail(403, 'Комментировать этот пост нельзя');

    const replied = replyTo != null ? db.comments.find((x) => x.id === replyTo && x.postId === postId) : undefined;
    if (replyTo != null && (!replied || hidden(replied.authorId))) fail(400, 'Комментарий, на который вы отвечаете, не найден');

    const c: DbComment = { id: id(), postId, authorId: u.id, body, createdAt: new Date().toISOString(), replyToId: replied?.id ?? null };
    db.comments.push(c);
    if (p) notify({ userId: p.authorId, actorId: u.id, kind: 'comment', postId, commentId: c.id });
    // Тому, кому ответили, — своё событие; автор записи уже узнал.
    if (replied && p && replied.authorId !== p.authorId) {
      notify({ userId: replied.authorId, actorId: u.id, kind: 'comment_reply', postId, commentId: c.id });
    }
    notifyPostMentions({ authorId: u.id, postId, commentId: c.id, body, skip: [p?.authorId, replied?.authorId] });
    return tick({ comment: toComment(c) });
  },

  deleteComment: (commentId: number) => {
    const u = requireMe()!;
    const c = db.comments.find((x) => x.id === commentId);
    if (!c) fail(404, 'Комментарий не найден');
    const post = db.posts.find((p) => p.id === c!.postId);
    if (c!.authorId !== u.id && post?.authorId !== u.id) fail(403, 'Можно удалять только свои комментарии');
    db.comments = db.comments.filter((x) => x.id !== commentId);
    db.notifications = db.notifications.filter((n) => n.commentId !== commentId);
    return tick({ ok: true as const });
  },

  postThread: (postId: number) => {
    const p = visiblePosts().find((x) => x.id === postId);
    if (!p) fail(404, 'Пост не найден');
    const rootId = threadOfPost(p!)?.rootId ?? p!.id;
    const chain: DbPost[] = [];
    for (let cur = db.posts.find((x) => x.id === rootId); cur; cur = db.posts.find((x) => x.continuesId === cur!.id)) chain.push(cur);
    return tick({ posts: chain.map(toPost) });
  },

  post: (postId: number) => {
    const p = visiblePosts().find((x) => x.id === postId);
    // Мусорный id, удалённая запись и запись заблокированного — одно и то же
    // «не найдено»: страница /p/<что угодно> показывает обычное пустое место.
    if (!p || hidden(p.authorId)) fail(404, 'Пост не найден');
    return tick({ post: toPost(p!) });
  },

  // ─ Поиск по записям, архив и закладки ─────────────────────────────────

  searchPosts: (q: string, opts: { author?: string; cursor?: number | null } = {}) => {
    // Сервер обрезает запрос до 100 символов — витрина обязана делать то же,
    // иначе длинный ввод дал бы здесь другую выдачу.
    const query = String(q).slice(0, 100);
    const terms = searchTerms(query);

    // Пустой и бессмысленный запрос («одни знаки препинания») — не ошибка, а
    // промежуточное состояние строки ввода. Сервер тоже отвечает 200.
    if (terms.length === 0) {
      const empty: SearchPage = { posts: [], nextCursor: null, query };
      return tick(empty);
    }

    // Порядок хронологический, а не по релевантности: это дневник, а не
    // поисковик, и keyset-пагинация по id работает только так.
    let list = visiblePosts()
      .filter((post) => matchesTerms(post.body, terms))
      .sort((a, b) => b.id - a.id);

    if (opts.author) {
      const u = byName(opts.author);
      list = u ? list.filter((post) => post.authorId === u.id) : [];
    }
    if (opts.cursor != null) list = list.filter((post) => post.id < opts.cursor!);

    const page = list.slice(0, PAGE);
    const result: SearchPage = {
      posts: page.map(toPost),
      nextCursor: list.length > PAGE ? page.at(-1)!.id : null,
      query,
    };
    return tick(result);
  },

  archive: (username: string) => {
    const u = byName(username);
    if (!u) fail(404, 'Пользователь не найден');

    // Числа в архиве считаются по той же видимости, что и лента: «12 записей»
    // над месяцем, который откроется пустым, читались бы как поломка.
    const counts = new Map<string, number>();
    for (const post of visiblePosts()) {
      if (post.authorId !== u!.id) continue;
      // Месяц — первые семь символов ISO-строки, то есть по UTC.
      const month = post.createdAt.slice(0, 7);
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }

    const months: ArchiveMonth[] = [...counts.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => b.month.localeCompare(a.month));

    return tick({ months, total: months.reduce((sum, m) => sum + m.count, 0) });
  },

  setBookmark: (postId: number, on: boolean) => {
    const u = requireMe()!;
    const p = db.posts.find((x) => x.id === postId);
    if (!p) fail(404, 'Пост не найден');
    // Сохранить скрытую блокировкой запись нельзя — ответ тот же «не найдено»,
    // что и у несуществующей. А вот снять закладку можно всегда: фильтр
    // блокировки стоит на чтении, строка закладки остаётся, и требуй мы
    // видимости на удалении — такая закладка застряла бы навсегда.
    // Сверено с BE-03 (`.team/inbox/to-frontend.md`).
    if (on && postHidden(p!)) fail(404, 'Пост не найден');

    const saved = db.bookmarks.find((b) => b.userId === u.id && b.postId === postId);
    // Идемпотентно: повтор не создаёт вторую строку и не поднимает закладку
    // наверх списка — у неё остаётся прежний id, то есть прежнее место.
    if (on && !saved) {
      db.bookmarks.push({ id: id(), userId: u.id, postId, createdAt: new Date().toISOString() });
    }
    if (!on && saved) db.bookmarks = db.bookmarks.filter((b) => b !== saved);

    // Уведомления здесь нет намеренно: закладка приватна, и этим она
    // отличается от отметки — автор о ней знать не должен.
    return tick({ bookmarkedByMe: on });
  },

  bookmarks: (cursor?: number | null) => {
    const u = requireMe()!;

    // Фильтр стоит на чтении, а не на сохранении: заблокировали автора после
    // того, как сохранили его запись, — она пропадает из списка, строка
    // закладки остаётся. Правило одно — фильтровать там, где показываем.
    let list = db.bookmarks
      .filter((b) => b.userId === u.id)
      .filter((b) => {
        const post = db.posts.find((x) => x.id === b.postId);
        return post != null && !postHidden(post);
      })
      .sort((a, b) => b.id - a.id);

    // Курсор — id закладки: список листается по времени сохранения.
    if (cursor != null) list = list.filter((b) => b.id < cursor);

    const page = list.slice(0, PAGE);
    const result: Page = {
      posts: page.map((b) => toPost(db.posts.find((x) => x.id === b.postId)!)),
      nextCursor: list.length > PAGE ? page.at(-1)!.id : null,
    };
    return tick(result);
  },
};
