/**
 * Подставной бэкенд для витрины на GitHub Pages.
 *
 * Pages раздаёт только статику: ни Node-процесса, ни базы, ни диска под
 * загрузки. Поэтому здесь те же методы, что у настоящего api, но всё живёт в
 * памяти вкладки. Перезагрузка возвращает засеянное состояние — так и написано
 * в плашке, чтобы демо ничего не обещало сверх того, что делает.
 *
 * В обычную сборку этот файл не попадает: см. переключение в api.ts.
 */
import type {
  Author, Comment, Conversation, Media, Message, Page, Post, User,
} from '../api';
import { ApiError } from '../api';

type DbUser = {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  createdAt: string;
  email: string;
  password: string;
};

type DbPost = {
  id: number;
  authorId: number;
  body: string;
  createdAt: string;
  media: Media | null;
};

type DbComment = { id: number; postId: number; authorId: number; body: string; createdAt: string };
type DbMessage = { id: number; fromId: number; toId: number; body: string; createdAt: string; readAt: string | null };

let users: DbUser[] = [];
let posts: DbPost[] = [];
let comments: DbComment[] = [];
let likes: { userId: number; postId: number }[] = [];
let follows: { followerId: number; followeeId: number }[] = [];
let messages: DbMessage[] = [];
let resets: { token: string; userId: number; expiresAt: number; usedAt: number | null }[] = [];
let meId: number | null = null;
let nextId = 1;

const id = () => nextId++;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Небольшая задержка: без неё состояния «Загружаю…» мигают в один кадр. */
const tick = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 80));

const fail = (status: number, message: string): never => {
  throw new ApiError(status, message);
};

/** Картинки рисуем как SVG в data: — бинарники в статическую сборку тащить незачем. */
function gradient(from: string, to: string, w = 720, h = 480, label = '') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    ${label ? `<text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(w / 18)}" text-anchor="middle" opacity=".75">${label}</text>` : ''}
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function seed() {
  users = [];
  posts = [];
  comments = [];
  likes = [];
  follows = [];
  messages = [];
  resets = [];
  nextId = 1;

  const make = (username: string, displayName: string, bio: string, avatar: string | null): DbUser => {
    const u: DbUser = {
      id: id(), username, displayName, bio, avatarUrl: avatar,
      createdAt: ago(60 * 24 * 40), email: `${username}@example.test`, password: 'parol12345',
    };
    users.push(u);
    return u;
  };

  const demo = make('demo', 'Ерлан', 'Собираю портфолио и пишу о том, что строю.', gradient('#0e7863', '#8265ba', 256, 256));
  const marina = make('marina', 'Марина Штольц', 'Читаю больше, чем успеваю обдумывать.', gradient('#8265ba', '#3b7a9c', 256, 256));
  const oleg = make('oleg_k', 'Олег Кузьмин', 'Чиню станки старше себя.', gradient('#ad5f34', '#488048', 256, 256));
  const nina = make('nina', 'Нина Барто', 'Поля, плёнка, проявка на кухне.', null);

  const post = (author: DbUser, body: string, minutes: number, media: Media | null = null) => {
    const p: DbPost = { id: id(), authorId: author.id, body, createdAt: ago(minutes), media };
    posts.push(p);
    return p;
  };

  const p1 = post(marina, 'Перечитала «Хазарский словарь» и поняла, что читала его неправильно оба предыдущих раза. Это не роман, а инструкция по чтению самого себя.', 12);
  const p2 = post(oleg, 'Сегодня в мастерской починил станок 1969 года. Инструкция к нему на четырёх языках, и ни один из них уже не звучит так, как звучал тогда.', 48);
  const p3 = post(nina, 'Вечер на набережной. Небо переходило из тёплого в холодное минут за десять — не успел дойти до моста.', 120, {
    url: gradient('#e08a4a', '#2c4a7c'),
    type: 'image',
    mime: 'image/svg+xml',
    name: 'zakat.png',
  });
  post(demo, 'Поднял свою соцсеть с нуля: профили, лента, лайки, комментарии, подписки, медиа и личные сообщения. Внутри — Express и SQLite без единой нативной зависимости.', 200);

  likes.push({ userId: demo.id, postId: p1.id }, { userId: oleg.id, postId: p1.id }, { userId: nina.id, postId: p1.id });
  likes.push({ userId: marina.id, postId: p2.id });
  likes.push({ userId: demo.id, postId: p3.id }, { userId: marina.id, postId: p3.id });

  comments.push(
    { id: id(), postId: p1.id, authorId: oleg.id, body: 'А какое издание? Мне попадалось только женское.', createdAt: ago(10) },
    { id: id(), postId: p1.id, authorId: marina.id, body: 'Мужское. Разница в одном абзаце, но он переворачивает финал.', createdAt: ago(8) },
    { id: id(), postId: p3.id, authorId: marina.id, body: 'Плёнка? Цвет совсем не цифровой.', createdAt: ago(100) },
  );

  follows.push(
    { followerId: demo.id, followeeId: marina.id },
    { followerId: demo.id, followeeId: nina.id },
    { followerId: marina.id, followeeId: demo.id },
    { followerId: oleg.id, followeeId: marina.id },
  );

  const dm = (from: DbUser, to: DbUser, body: string, minutes: number, read = true) => {
    messages.push({ id: id(), fromId: from.id, toId: to.id, body, createdAt: ago(minutes), readAt: read ? ago(minutes) : null });
  };

  dm(marina, demo, 'Слушай, ты был на той выставке в подвале на Гоголя?', 90);
  dm(demo, marina, 'Был, но не досмотрел — закрывались. Успел только первый зал.', 88);
  dm(marina, demo, 'Второй там и был весь смысл. Они его специально спрятали за лестницей.', 86);
  dm(demo, marina, 'Тогда схожу ещё раз. В выходные?', 84);
  dm(marina, demo, 'Давай в субботу до обеда, пока пусто.', 82);
  dm(oleg, demo, 'Привет! Нашёл тот станок с фотографии — расскажу при встрече.', 30, false);
  dm(oleg, demo, 'И ещё: у тебя тот аккорд из поста — это Am7?', 25, false);

  meId = demo.id;
}

// Засев только в режиме витрины: в обычной сборке ветка мертва, и мок
// вместе с этими данными выбрасывается из бандла целиком.
if (import.meta.env.VITE_DEMO === '1') seed();

const byId = (userId: number) => users.find((u) => u.id === userId);
const byName = (username: string) => users.find((u) => u.username === username.toLowerCase());
const byEmail = (mail: string) => users.find((u) => u.email === mail.toLowerCase());

const me = () => (meId != null ? byId(meId) ?? null : null);
const requireMe = () => me() ?? fail(401, 'Требуется вход в аккаунт');

const author = (u: DbUser): Author => ({
  id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl,
});

const publicUser = (u: DbUser): User => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  bio: u.bio,
  avatarUrl: u.avatarUrl,
  createdAt: u.createdAt,
  postCount: posts.filter((p) => p.authorId === u.id).length,
  followerCount: follows.filter((f) => f.followeeId === u.id).length,
  followingCount: follows.filter((f) => f.followerId === u.id).length,
  followedByMe: follows.some((f) => f.followerId === meId && f.followeeId === u.id),
});

const toPost = (p: DbPost): Post => ({
  id: p.id,
  body: p.body,
  createdAt: p.createdAt,
  likeCount: likes.filter((l) => l.postId === p.id).length,
  commentCount: comments.filter((c) => c.postId === p.id).length,
  likedByMe: likes.some((l) => l.postId === p.id && l.userId === meId),
  media: p.media,
  author: author(byId(p.authorId)!),
});

const toComment = (c: DbComment): Comment => ({
  id: c.id,
  postId: c.postId,
  body: c.body,
  createdAt: c.createdAt,
  author: author(byId(c.authorId)!),
});

const toMessage = (m: DbMessage): Message => ({
  id: m.id, body: m.body, createdAt: m.createdAt, fromId: m.fromId, toId: m.toId, readAt: m.readAt,
});

const PAGE = 20;

export const mockApi = {
  me: () => tick({ user: me() ? publicUser(me()!) : null }),

  register: (input: { username: string; displayName: string; email: string; password: string }) => {
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      fail(400, 'Имя пользователя: 3–20 символов, только латиница, цифры и _');
    }
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail(400, 'Некорректный email');
    if (input.password.length < 8) fail(400, 'Пароль должен быть не короче 8 символов');
    if (byName(username)) fail(409, 'Это имя пользователя уже занято');
    if (users.some((u) => u.email === email)) fail(409, 'На этот email уже зарегистрирован аккаунт');

    const u: DbUser = {
      id: id(), username,
      displayName: input.displayName.trim() || username,
      bio: '', avatarUrl: null, createdAt: new Date().toISOString(), email, password: input.password,
    };
    users.push(u);
    meId = u.id;
    return tick({ user: publicUser(u) });
  },

  login: (input: { username: string; password: string }) => {
    const u = byName(input.username.trim());
    if (!u || u.password !== input.password) fail(401, 'Неверное имя пользователя или пароль');
    meId = u!.id;
    return tick({ user: publicUser(u!) });
  },

  logout: () => {
    meId = null;
    return tick({ ok: true as const });
  },

  forgotPassword: (rawEmail: string) => {
    const mail = rawEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) fail(400, 'Некорректный email');

    const user = byEmail(mail);
    const message = 'Если такой email зарегистрирован, на него отправлена ссылка';

    let demoLink: string | undefined;
    if (user) {
      resets = resets.filter((r) => !(r.userId === user.id && !r.usedAt));
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      resets.push({ token, userId: user.id, expiresAt: Date.now() + 30 * 60_000, usedAt: null });
      // Путь без BASE_URL — <Link to> сам добавляет basename роутера;
      // задвоить префикс, вставив его дважды, было бы легко.
      demoLink = `/reset-password/${token}`;
      // А в консоли нужен уже полный адрес, который можно скопировать в
      // строку браузера — как единственный канал у консоли сервера в проде.
      console.log(`✉️  [демо] ссылка для сброса пароля: ${location.origin}${import.meta.env.BASE_URL}reset-password/${token}`);
    }

    return tick({ ok: true as const, message, demoLink });
  },

  checkResetToken: (token: string) => {
    const r = resets.find((x) => x.token === token);
    const valid = Boolean(r && !r.usedAt && r.expiresAt > Date.now());
    return tick({ valid });
  },

  resetPassword: (token: string, password: string) => {
    if (password.length < 8) fail(400, 'Пароль должен быть не короче 8 символов');
    const r = resets.find((x) => x.token === token);
    if (!r || r.usedAt || r.expiresAt <= Date.now()) {
      fail(400, 'Ссылка недействительна или уже использована');
    }
    const user = byId(r!.userId)!;
    user.password = password;
    r!.usedAt = Date.now();
    if (meId === user.id) meId = null; // как и на бэкенде — сброс гасит текущую сессию
    return tick({ ok: true as const });
  },

  profile: (username: string) => {
    const u = byName(username);
    if (!u) fail(404, 'Пользователь не найден');
    return tick({ user: publicUser(u!) });
  },

  updateProfile: (input: { displayName: string; bio: string }) => {
    const u = requireMe()!;
    if (!input.displayName.trim()) fail(400, '«имя»: минимум 1 символов');
    if (input.bio.length > 200) fail(400, '«о себе»: максимум 200 символов');
    u.displayName = input.displayName.trim();
    u.bio = input.bio.trim();
    return tick({ user: publicUser(u) });
  },

  posts: (opts: { author?: string; cursor?: number | null; feed?: 'following' } = {}) => {
    let list = [...posts].sort((a, b) => b.id - a.id);

    if (opts.author) {
      const u = byName(opts.author);
      list = u ? list.filter((p) => p.authorId === u.id) : [];
    }
    if (opts.feed === 'following') {
      if (!me()) fail(401, 'Войдите, чтобы смотреть подписки');
      const mine = follows.filter((f) => f.followerId === meId).map((f) => f.followeeId);
      list = list.filter((p) => p.authorId === meId || mine.includes(p.authorId));
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
    posts.push(p);
    return tick({ post: toPost(p) });
  },

  deletePost: (postId: number) => {
    const u = requireMe()!;
    const p = posts.find((x) => x.id === postId);
    if (!p) fail(404, 'Пост не найден');
    if (p!.authorId !== u.id) fail(403, 'Это не ваш пост');
    posts = posts.filter((x) => x.id !== postId);
    comments = comments.filter((c) => c.postId !== postId);
    likes = likes.filter((l) => l.postId !== postId);
    return tick({ ok: true as const });
  },

  setLike: (postId: number, liked: boolean) => {
    const u = requireMe()!;
    likes = likes.filter((l) => !(l.postId === postId && l.userId === u.id));
    if (liked) likes.push({ userId: u.id, postId });
    return tick({ likeCount: likes.filter((l) => l.postId === postId).length, likedByMe: liked });
  },

  comments: (postId: number) =>
    tick({ comments: comments.filter((c) => c.postId === postId).sort((a, b) => a.id - b.id).map(toComment) }),

  addComment: (postId: number, text: string) => {
    const u = requireMe()!;
    const body = text.trim();
    if (!body) fail(400, '«текст комментария»: минимум 1 символов');
    if (body.length > 300) fail(400, '«текст комментария»: максимум 300 символов');
    const c: DbComment = { id: id(), postId, authorId: u.id, body, createdAt: new Date().toISOString() };
    comments.push(c);
    return tick({ comment: toComment(c) });
  },

  deleteComment: (commentId: number) => {
    const u = requireMe()!;
    const c = comments.find((x) => x.id === commentId);
    if (!c) fail(404, 'Комментарий не найден');
    const post = posts.find((p) => p.id === c!.postId);
    if (c!.authorId !== u.id && post?.authorId !== u.id) fail(403, 'Можно удалять только свои комментарии');
    comments = comments.filter((x) => x.id !== commentId);
    return tick({ ok: true as const });
  },

  setAvatar: (file: File) => {
    const u = requireMe()!;
    u.avatarUrl = URL.createObjectURL(file);
    return tick({ user: publicUser(u) });
  },

  removeAvatar: () => {
    const u = requireMe()!;
    u.avatarUrl = null;
    return tick({ user: publicUser(u) });
  },

  searchUsers: (q: string) => {
    const query = q.trim().toLowerCase();
    if (!query) return tick({ users: [] });

    const scored = users
      .map((u) => {
        const username = u.username.toLowerCase();
        const displayName = u.displayName.toLowerCase();
        let rank: number | null = null;
        if (username === query) rank = 0;
        else if (username.startsWith(query)) rank = 1;
        else if (displayName.startsWith(query)) rank = 2;
        else if (username.includes(query) || displayName.includes(query)) rank = 3;
        return rank === null ? null : { u, rank };
      })
      .filter((x): x is { u: DbUser; rank: number } => x !== null)
      .sort((a, b) => a.rank - b.rank || a.u.username.localeCompare(b.u.username))
      .slice(0, 20);

    return tick({ users: scored.map(({ u }) => author(u)) });
  },

  setFollow: (username: string, following: boolean) => {
    const u = requireMe()!;
    const target = byName(username);
    if (!target) fail(404, 'Пользователь не найден');
    if (target!.id === u.id) fail(400, 'Нельзя подписаться на себя');

    follows = follows.filter((f) => !(f.followerId === u.id && f.followeeId === target!.id));
    if (following) follows.push({ followerId: u.id, followeeId: target!.id });

    return tick({
      followedByMe: following,
      followerCount: follows.filter((f) => f.followeeId === target!.id).length,
    });
  },

  conversations: () => {
    const u = requireMe()!;
    const mine = messages.filter((m) => m.fromId === u.id || m.toId === u.id);
    const others = [...new Set(mine.map((m) => (m.fromId === u.id ? m.toId : m.fromId)))];

    const list: Conversation[] = others
      .map((otherId) => {
        const thread = mine.filter((m) => m.fromId === otherId || m.toId === otherId);
        const last = thread.reduce((a, b) => (a.id > b.id ? a : b));
        return {
          user: author(byId(otherId)!),
          unread: messages.filter((m) => m.toId === u.id && m.fromId === otherId && !m.readAt).length,
          lastMessage: toMessage(last),
        };
      })
      .sort((a, b) => b.lastMessage.id - a.lastMessage.id);

    return tick({
      conversations: list,
      unreadTotal: messages.filter((m) => m.toId === u.id && !m.readAt).length,
    });
  },

  thread: (username: string, cursor?: number | null) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');

    let list = messages
      .filter((m) =>
        (m.fromId === u.id && m.toId === other!.id) || (m.fromId === other!.id && m.toId === u.id))
      .sort((a, b) => b.id - a.id);

    if (cursor != null) list = list.filter((m) => m.id < cursor);

    const page = list.slice(0, 30);
    return tick({
      user: author(other!),
      messages: page.map(toMessage).reverse(),
      nextCursor: list.length > 30 ? page.at(-1)!.id : null,
    });
  },

  sendMessage: (username: string, text: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    if (other!.id === u.id) fail(400, 'Нельзя написать самому себе');
    const body = text.trim();
    if (!body) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > 1000) fail(400, '«сообщение»: максимум 1000 символов');

    const m: DbMessage = {
      id: id(), fromId: u.id, toId: other!.id, body,
      createdAt: new Date().toISOString(), readAt: null,
    };
    messages.push(m);
    return tick({ message: toMessage(m) });
  },

  markRead: (username: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    for (const m of messages) {
      if (m.toId === u.id && m.fromId === other!.id && !m.readAt) m.readAt = new Date().toISOString();
    }
    return tick({
      ok: true as const,
      unreadTotal: messages.filter((m) => m.toId === u.id && !m.readAt).length,
    });
  },
};
