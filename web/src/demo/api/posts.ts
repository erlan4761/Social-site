import { type ArchiveMonth, type Page } from '../../api';
import { type DbPost, type DbComment, db, id, tick, fail } from '../store';
import { byName, me, requireMe, hidden, visiblePosts } from '../model/people';
import { searchTerms, matchesTerms, visibleComments, toPost, toComment, PAGE, PERIOD_RE, type SearchPage } from '../model/posts';
import { notify, dropNotification } from '../model/notifications';

/** Методы витрины: лента, записи, комментарии, поиск, архив, закладки. */

export const postsApi = {
  posts: (opts: { author?: string; cursor?: number | null; feed?: 'following'; period?: string } = {}) => {
    // Блокировка — главный фильтр ленты: и общей, и «по подпискам», и профильной.
    let list = visiblePosts().sort((a, b) => b.id - a.id);

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
      list = list.filter((p) => p.authorId === db.meId || mine.includes(p.authorId));
    }
    if (opts.cursor != null) list = list.filter((p) => p.id < opts.cursor!);

    const page = list.slice(0, PAGE);
    const result: Page = {
      posts: page.map(toPost),
      nextCursor: list.length > PAGE ? page.at(-1)!.id : null,
    };
    return tick(result);
  },

  createPost: (text: string, media?: File | null) => {
    const u = requireMe()!;
    const body = text.trim();
    if (!body && !media) fail(400, '«текст поста»: минимум 1 символов');
    if (body.length > 500) fail(400, '«текст поста»: максимум 500 символов');

    const p: DbPost = {
      id: id(), authorId: u.id, body, createdAt: new Date().toISOString(),
      media: media
        ? {
            // objectURL живёт, пока открыта вкладка — ровно столько же, сколько демо.
            url: URL.createObjectURL(media),
            type: media.type.startsWith('video/') ? 'video' : media.type.startsWith('audio/') ? 'audio' : 'image',
            mime: media.type,
            name: media.name,
          }
        : null,
    };
    db.posts.push(p);
    return tick({ post: toPost(p) });
  },

  deletePost: (postId: number) => {
    const u = requireMe()!;
    const p = db.posts.find((x) => x.id === postId);
    if (!p) fail(404, 'Пост не найден');
    if (p!.authorId !== u.id) fail(403, 'Это не ваш пост');
    db.posts = db.posts.filter((x) => x.id !== postId);
    db.comments = db.comments.filter((c) => c.postId !== postId);
    db.likes = db.likes.filter((l) => l.postId !== postId);
    db.bookmarks = db.bookmarks.filter((b) => b.postId !== postId);
    // События о записи ведут туда, где больше ничего нет — каскад, как в схеме.
    db.notifications = db.notifications.filter((n) => n.postId !== postId);
    return tick({ ok: true as const });
  },

  setLike: (postId: number, liked: boolean) => {
    const u = requireMe()!;
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
    if (p && hidden(p.authorId)) fail(404, 'Пост не найден');
    return tick({ comments: visibleComments(postId).sort((a, b) => a.id - b.id).map(toComment) });
  },

  addComment: (postId: number, text: string, replyTo?: number | null) => {
    const u = requireMe()!;
    const body = text.trim();
    if (!body) fail(400, '«текст комментария»: минимум 1 символов');
    if (body.length > 300) fail(400, '«текст комментария»: максимум 300 символов');

    const p = db.posts.find((x) => x.id === postId);
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

  post: (postId: number) => {
    const p = db.posts.find((x) => x.id === postId);
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
    if (on && hidden(p!.authorId)) fail(404, 'Пост не найден');

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
        return post != null && !hidden(post.authorId);
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
