import { mockApi } from './demo/mockApi';

export type User = {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  createdAt: string;
  postCount?: number;
  followerCount?: number;
  followingCount?: number;
  followedByMe?: boolean;
  /** Приходят только из `GET /users/:username` для чужого профиля. */
  blockedByMe?: boolean;
  blocksMe?: boolean;
};

export type Author = { id: number; username: string; displayName: string; avatarUrl: string | null };

/** Человек в переписке: плюс время последнего визита для «в сети». `null` —
 *  не заходил после появления этой отметки или пара в блокировке. */
export type Person = Author & { lastSeenAt: string | null };

export type MediaKind = 'image' | 'video' | 'audio';

export type Media = {
  url: string;
  type: MediaKind;
  mime: string;
  name: string | null;
};

export type Post = {
  id: number;
  body: string;
  createdAt: string;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  /** Закладка смотрящего. Она приватна: автор записи о ней не узнаёт,
   *  уведомления по ней нет — этим она и отличается от отметки. */
  bookmarkedByMe: boolean;
  media: Media | null;
  author: Author;
};

export type Comment = {
  id: number;
  postId: number;
  body: string;
  createdAt: string;
  author: Author;
};

export type Page = { posts: Post[]; nextCursor: number | null };

/** Строка архива: `2026-09` и число записей, видимых **этому** смотрящему. */
export type ArchiveMonth = { month: string; count: number };

/** Набор реакций фиксирован — тот же список, что на сервере. */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;

export type Reaction = { emoji: string; count: number; mine: boolean };

/** Цитата в ответе. `deleted` — оригинал удалён или скрыт блокировкой: для
 *  читающего это одно и то же «сообщение недоступно». */
export type Quote =
  | { id: number; author: { id: number; displayName: string }; body: string; deleted?: undefined }
  | { id: number; deleted: true };

/** Общее у сообщений ЛС и групп: правка, пересылка, ответ, реакции. */
export type MessageExtras = {
  editedAt: string | null;
  forwardedFrom: { username: string; displayName: string } | null;
  replyTo: Quote | null;
  reactions: Reaction[];
};

/** Откуда пересылается сообщение. */
export type ForwardRef = { from: 'dm' | 'chat'; id: number };

/** Куда: в личную переписку по имени или в групповой чат по id. */
export type ForwardTarget = { kind: 'dm'; username: string } | { kind: 'chat'; id: number };

export type Message = MessageExtras & {
  id: number;
  body: string;
  createdAt: string;
  fromId: number;
  toId: number;
  readAt: string | null;
};

export type Conversation = {
  user: Person;
  unread: number;
  lastMessage: Message;
  /** Пара в блокировке: история видна, форма ответа заменяется плашкой. */
  blocked?: boolean;
};

export type NotificationKind =
  | 'like'
  | 'comment'
  | 'follow'
  | 'message'
  | 'chat_message'
  | 'chat_invite';

/** Обрезанный сервером кусок текста поста или комментария — 80 символов. */
export type NotificationRef = { id: number; excerpt: string };

export type Notification = {
  id: number;
  kind: NotificationKind;
  createdAt: string;
  /** null — событие ещё не прочитано. */
  readAt: string | null;
  actor: Author;
  post: NotificationRef | null;
  comment: NotificationRef | null;
  chat: { id: number; title: string } | null;
};

/** Три счётчика одним запросом — иначе оболочка опрашивала бы три эндпоинта. */
export type Badges = { messages: number; chats: number; notifications: number };

/** Список заблокированных — те же поля, что у автора поста. */
export type BlockedUser = Author;

export type ReportTargetType = 'post' | 'comment' | 'user';
export type ReportReason = 'spam' | 'abuse' | 'adult' | 'other';

export type Chat = {
  id: number;
  title: string;
  ownerId: number;
  createdAt: string;
  members: Person[];
  memberCount: number;
  iAmOwner: boolean;
};

export type ChatMessage = MessageExtras & {
  id: number;
  chatId: number;
  body: string;
  createdAt: string;
  author: Author;
};

export type ChatSummary = Chat & {
  unread: number;
  lastMessage: ChatMessage | null;
  /** Самая дальняя отметка прочтения среди остальных участников: своё
   *  сообщение с id не больше неё кто-то уже прочитал. */
  readUpTo: number;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      // FormData ставит свой Content-Type с boundary — задать его руками нельзя.
      headers: init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : undefined,
      ...init,
    });
  } catch {
    throw new ApiError(0, 'Сервер недоступен. Проверьте, что он запущен.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Что-то пошло не так');
  return data as T;
}

const body = (payload: unknown) => JSON.stringify(payload);

const realApi = {
  me: () => request<{ user: User | null }>('/auth/me'),

  register: (input: { username: string; displayName: string; email: string; password: string }) =>
    request<{ user: User }>('/auth/register', { method: 'POST', body: body(input) }),

  login: (input: { username: string; password: string }) =>
    request<{ user: User }>('/auth/login', { method: 'POST', body: body(input) }),

  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),

  // demoLink настоящий бэкенд никогда не возвращает — письмо реально уходит
  // по почте. В демо на GitHub Pages слать некуда, поэтому мок кладёт ссылку
  // прямо в ответ, чтобы её можно было показать кликабельной: переход внутри
  // приложения не перезагружает страницу и не роняет память мока (а обычная
  // навигация по вставленной в адресную строку ссылке — роняет).
  forgotPassword: (email: string) =>
    request<{ ok: true; message: string; demoLink?: string }>('/auth/forgot-password', { method: 'POST', body: body({ email }) }),

  checkResetToken: (token: string) =>
    request<{ valid: boolean }>(`/auth/reset-password/${encodeURIComponent(token)}`),

  resetPassword: (token: string, password: string) =>
    request<{ ok: true }>('/auth/reset-password', { method: 'POST', body: body({ token, password }) }),

  profile: (username: string) =>
    request<{ user: User }>(`/users/${encodeURIComponent(username)}`),

  updateProfile: (input: { displayName: string; bio: string }) =>
    request<{ user: User }>('/users/me', { method: 'PATCH', body: body(input) }),

  // period — `YYYY` или `YYYY-MM`; мусор сервер отвергает 400, потому что
  // период человек видит в адресе и может исправить, в отличие от курсора.
  posts: (opts: { author?: string; cursor?: number | null; feed?: 'following'; period?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.author) params.set('author', opts.author);
    if (opts.cursor != null) params.set('cursor', String(opts.cursor));
    if (opts.feed) params.set('feed', opts.feed);
    if (opts.period) params.set('period', opts.period);
    const qs = params.toString();
    return request<Page>(`/posts${qs ? `?${qs}` : ''}`);
  },

  /** Text-only posts stay JSON; a file forces multipart. */
  createPost: (text: string, media?: File | null) => {
    if (!media) {
      return request<{ post: Post }>('/posts', { method: 'POST', body: body({ body: text }) });
    }
    const form = new FormData();
    form.set('body', text);
    form.set('media', media);
    return request<{ post: Post }>('/posts', { method: 'POST', body: form });
  },

  deletePost: (id: number) => request<{ ok: true }>(`/posts/${id}`, { method: 'DELETE' }),

  setLike: (id: number, liked: boolean) =>
    request<{ likeCount: number; likedByMe: boolean }>(`/posts/${id}/like`, {
      method: liked ? 'PUT' : 'DELETE',
    }),

  comments: (postId: number) =>
    request<{ comments: Comment[] }>(`/posts/${postId}/comments`),

  addComment: (postId: number, text: string) =>
    request<{ comment: Comment }>(`/posts/${postId}/comments`, {
      method: 'POST',
      body: body({ body: text }),
    }),

  deleteComment: (id: number) =>
    request<{ ok: true }>(`/comments/${id}`, { method: 'DELETE' }),

  setAvatar: (file: File) => {
    const form = new FormData();
    form.set('avatar', file);
    return request<{ user: User }>('/users/me/avatar', { method: 'PUT', body: form });
  },

  removeAvatar: () => request<{ user: User }>('/users/me/avatar', { method: 'DELETE' }),

  conversations: () =>
    request<{ conversations: Conversation[]; unreadTotal: number }>('/messages'),

  // blocked приходит в корне ответа: история переписки остаётся видимой,
  // но форма ответа заменяется плашкой.
  thread: (username: string, cursor?: number | null) => {
    const qs = cursor != null ? `?cursor=${cursor}` : '';
    return request<{
      user: Person;
      messages: Message[];
      nextCursor: number | null;
      blocked?: boolean;
      /** Собеседник набирает сообщение прямо сейчас. */
      typing: boolean;
    }>(
      `/messages/${encodeURIComponent(username)}${qs}`,
    );
  },

  sendMessage: (username: string, text: string, replyTo?: number | null) =>
    request<{ message: Message }>(`/messages/${encodeURIComponent(username)}`, {
      method: 'POST',
      body: body({ body: text, replyTo: replyTo ?? undefined }),
    }),

  editMessage: (username: string, id: number, text: string) =>
    request<{ message: Message }>(`/messages/${encodeURIComponent(username)}/${id}`, {
      method: 'PATCH',
      body: body({ body: text }),
    }),

  deleteMessage: (username: string, id: number) =>
    request<{ ok: true }>(`/messages/${encodeURIComponent(username)}/${id}`, { method: 'DELETE' }),

  /** `null` — снять свою реакцию. */
  reactMessage: (username: string, id: number, emoji: string | null) =>
    request<{ message: Message }>(`/messages/${encodeURIComponent(username)}/${id}/reaction`, {
      method: emoji ? 'PUT' : 'DELETE',
      body: emoji ? body({ emoji }) : undefined,
    }),

  typing: (username: string) =>
    request<{ ok: true }>(`/messages/${encodeURIComponent(username)}/typing`, { method: 'PUT' }),

  /** Переслать сообщение в личную переписку или в чат. */
  forward: (target: ForwardTarget, source: ForwardRef) =>
    target.kind === 'dm'
      ? request<{ message: Message }>(`/messages/${encodeURIComponent(target.username)}`, {
          method: 'POST',
          body: body({ forward: source }),
        })
      : request<{ message: ChatMessage }>(`/chats/${target.id}/messages`, {
          method: 'POST',
          body: body({ forward: source }),
        }),

  markRead: (username: string) =>
    request<{ ok: true; unreadTotal: number }>(`/messages/${encodeURIComponent(username)}/read`, {
      method: 'PUT',
    }),

  searchUsers: (q: string) =>
    request<{ users: Author[] }>(`/users/search?q=${encodeURIComponent(q)}`),

  setFollow: (username: string, following: boolean) =>
    request<{ followedByMe: boolean; followerCount: number }>(
      `/users/${encodeURIComponent(username)}/follow`,
      { method: following ? 'PUT' : 'DELETE' },
    ),

  // ─ Уведомления ────────────────────────────────────────────────────────

  notifications: (cursor?: number | null) => {
    const qs = cursor != null ? `?cursor=${cursor}` : '';
    return request<{ notifications: Notification[]; nextCursor: number | null; unread: number }>(
      `/notifications${qs}`,
    );
  },

  /** Гасит все события разом — кнопка «Отметить все прочитанными». */
  readAllNotifications: () =>
    request<{ ok: true; unread: number }>('/notifications/read', { method: 'PUT' }),

  /** Гасит одно событие. Чужое и несуществующее — одинаково 404. */
  readNotification: (id: number) =>
    request<{ ok: true; unread: number }>(`/notifications/${id}/read`, { method: 'PUT' }),

  /** Три счётчика одним запросом. Требует входа: анониму отвечает 401. */
  badges: () => request<Badges>('/badges'),

  /** Один пост — уведомление о лайке или ответе должно вести на предмет разговора. */
  post: (id: number) => request<{ post: Post }>(`/posts/${id}`),

  // ─ Поиск по записям, архив и закладки ─────────────────────────────────

  /**
   * Полнотекстовый поиск по записям. Пустой и бессмысленный запрос — не
   * ошибка: сервер отвечает 200 с пустым списком, потому что «одни знаки
   * препинания» — это промежуточное состояние строки ввода, а не сбой.
   * Порядок хронологический (`id DESC`), а не по релевантности.
   */
  searchPosts: (q: string, opts: { author?: string; cursor?: number | null } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.author) params.set('author', opts.author);
    if (opts.cursor != null) params.set('cursor', String(opts.cursor));
    return request<{ posts: Post[]; nextCursor: number | null; query: string }>(
      `/search/posts?${params.toString()}`,
    );
  },

  /** Месяцы, в которых у автора есть видимые смотрящему записи, новые сверху. */
  archive: (username: string) =>
    request<{ months: ArchiveMonth[]; total: number }>(
      `/users/${encodeURIComponent(username)}/archive`,
    ),

  /** Идемпотентно: повторное сохранение не создаёт вторую закладку. */
  setBookmark: (id: number, on: boolean) =>
    request<{ bookmarkedByMe: boolean }>(`/posts/${id}/bookmark`, {
      method: on ? 'PUT' : 'DELETE',
    }),

  /**
   * Курсор здесь — id **закладки**, а не записи: список листается по времени
   * сохранения. Сохранил старую запись — она обязана оказаться сверху.
   */
  bookmarks: (cursor?: number | null) => {
    const qs = cursor != null ? `?cursor=${cursor}` : '';
    return request<Page>(`/bookmarks${qs}`);
  },

  // ─ Блокировки и жалобы ────────────────────────────────────────────────

  setBlock: (username: string, blocked: boolean) =>
    request<{ blockedByMe: boolean }>(`/users/${encodeURIComponent(username)}/block`, {
      method: blocked ? 'PUT' : 'DELETE',
    }),

  blockedUsers: () => request<{ users: BlockedUser[] }>('/users/me/blocks'),

  /** Повторная жалоба на тот же объект не создаёт вторую — приходит alreadyReported. */
  report: (input: {
    targetType: ReportTargetType;
    targetId: number;
    reason: ReportReason;
    note?: string;
  }) =>
    request<{ ok: true; alreadyReported: boolean }>('/reports', {
      method: 'POST',
      body: body(input),
    }),

  // ─ Групповые чаты ─────────────────────────────────────────────────────

  chats: () => request<{ chats: ChatSummary[]; unreadTotal: number }>('/chats'),

  /** members — имена пользователей, не id: сервер ищет собеседников по имени. */
  createChat: (input: { title: string; members: string[] }) =>
    request<{ chat: Chat }>('/chats', { method: 'POST', body: body(input) }),

  chat: (id: number) => request<{ chat: Chat }>(`/chats/${id}`),

  renameChat: (id: number, title: string) =>
    request<{ chat: Chat }>(`/chats/${id}`, { method: 'PATCH', body: body({ title }) }),

  deleteChat: (id: number) => request<{ ok: true }>(`/chats/${id}`, { method: 'DELETE' }),

  chatMessages: (id: number, cursor?: number | null) => {
    const qs = cursor != null ? `?cursor=${cursor}` : '';
    return request<{
      chat: Chat;
      messages: ChatMessage[];
      nextCursor: number | null;
      readUpTo: number;
      /** Кто из остальных участников набирает сообщение прямо сейчас. */
      typing: { id: number; displayName: string }[];
    }>(
      `/chats/${id}/messages${qs}`,
    );
  },

  sendChatMessage: (id: number, text: string, replyTo?: number | null) =>
    request<{ message: ChatMessage }>(`/chats/${id}/messages`, {
      method: 'POST',
      body: body({ body: text, replyTo: replyTo ?? undefined }),
    }),

  editChatMessage: (chatId: number, id: number, text: string) =>
    request<{ message: ChatMessage }>(`/chats/${chatId}/messages/${id}`, {
      method: 'PATCH',
      body: body({ body: text }),
    }),

  deleteChatMessage: (chatId: number, id: number) =>
    request<{ ok: true }>(`/chats/${chatId}/messages/${id}`, { method: 'DELETE' }),

  reactChatMessage: (chatId: number, id: number, emoji: string | null) =>
    request<{ message: ChatMessage }>(`/chats/${chatId}/messages/${id}/reaction`, {
      method: emoji ? 'PUT' : 'DELETE',
      body: emoji ? body({ emoji }) : undefined,
    }),

  chatTyping: (id: number) => request<{ ok: true }>(`/chats/${id}/typing`, { method: 'PUT' }),

  markChatRead: (id: number) =>
    request<{ ok: true; unread: number }>(`/chats/${id}/read`, { method: 'PUT' }),

  addChatMember: (id: number, username: string) =>
    request<{ chat: Chat }>(`/chats/${id}/members`, { method: 'POST', body: body({ username }) }),

  /** left: true — вы вышли сами, а не удалили кого-то другого. */
  removeChatMember: (id: number, username: string) =>
    request<{ ok: true; left?: boolean }>(
      `/chats/${id}/members/${encodeURIComponent(username)}`,
      { method: 'DELETE' },
    ),
};

/**
 * Витрина на GitHub Pages ходит в подставной бэкенд в браузере: Pages раздаёт
 * только статику, настоящему серверу там взяться неоткуда. Флаг ставится
 * сборкой (`vite build --mode demo`), в обычной сборке ветка мертва и код
 * мока в бандл не попадает.
 */
export const api: typeof realApi = import.meta.env.VITE_DEMO === '1'
  ? (mockApi as unknown as typeof realApi)
  : realApi;
