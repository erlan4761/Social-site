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
/**
 * Собеседник с временем визита. `lastSeenAt` — null, если время скрыто
 * блокировкой или настройкой; во втором случае `seenRecently` говорит,
 * заходил ли человек за последние дни («был(а) недавно»).
 */
export type Person = Author & { lastSeenAt: string | null; seenRecently?: boolean };

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
  | {
      id: number;
      author: { id: number; displayName: string };
      body: string;
      attachmentKind?: AttachmentKind | null;
      deleted?: undefined;
    }
  | { id: number; deleted: true };

export type AttachmentKind = 'image' | 'video' | 'audio' | 'voice' | 'videonote' | 'file';

/** Вложение сообщения. `url` отдаёт файл только тем, кто видит сообщение. */
export type Attachment = {
  url: string;
  kind: AttachmentKind;
  mime: string;
  name: string | null;
  size: number | null;
  /** Только у голосовых: секунды и «волна» — строка цифр 0–9, по столбику на цифру. */
  duration: number | null;
  wave: string | null;
};

/** Что уходит вместе с файлом. */
export type AttachmentInput = {
  file: Blob;
  name?: string;
  body?: string;
  replyTo?: number | null;
  voice?: { duration: number; wave: string };
  /** «Кружок» — видеосообщение до минуты. */
  videoNote?: { duration: number };
};

function attachmentForm(input: AttachmentInput) {
  const form = new FormData();
  form.append('file', input.file, input.name ?? 'file');
  if (input.body) form.append('body', input.body);
  if (input.replyTo != null) form.append('replyTo', String(input.replyTo));
  if (input.voice) {
    form.append('voice', '1');
    form.append('duration', String(input.voice.duration));
    form.append('wave', input.voice.wave);
  }
  if (input.videoNote) {
    form.append('videonote', '1');
    form.append('duration', String(input.videoNote.duration));
  }
  return form;
}

/** Общее у сообщений ЛС и групп: правка, пересылка, ответ, реакции, вложение. */
export type MessageExtras = {
  attachment: Attachment | null;
  /** Стикер из встроенного набора («plenka/hi») — у ЛС и групп; тогда текста нет. */
  sticker?: string | null;
  editedAt: string | null;
  forwardedFrom: ForwardedFrom | null;
  replyTo: Quote | null;
  reactions: Reaction[];
};

/** Откуда пересылается сообщение. */
export type ForwardRef = { from: 'dm' | 'chat' | 'channel'; id: number };

/** Найденное внутри переписки: автор есть у ЛС и групп, у канала — нет. */
export type ConversationHit = {
  id: number;
  body: string;
  createdAt: string;
  author: { id: number; displayName: string } | null;
};

/** Закреплённое сообщение переписки — для полосы под шапкой. */
export type PinnedPreview = { id: number; body: string; attachmentKind: AttachmentKind | null };

/** Откуда пересланное: от человека или из канала — подпись ведёт туда. */
export type ForwardedFrom =
  | { kind: 'user'; username: string; displayName: string }
  | { kind: 'channel'; handle: string; title: string };

/* ─ Каналы ─────────────────────────────────────────────────────────────── */

export type Channel = {
  id: number;
  handle: string;
  title: string;
  description: string;
  createdAt: string;
  owner: Author | null;
  iAmOwner: boolean;
  subscribed: boolean;
  subscriberCount: number;
};

/** Вариант опроса. `votes` — null, пока результаты скрыты: смотрящий ещё
 *  не голосовал, опрос открыт и создал его не он. `voters` — только в открытом. */
export type PollOption = { id: number; text: string; votes: number | null; voters: Author[] };

/** Опрос при сообщении группы или публикации канала. Вопрос — текст сообщения. */
export type Poll = {
  id: number;
  multiple: boolean;
  anonymous: boolean;
  closed: boolean;
  /** Сколько людей проголосовало — не голосов. */
  total: number;
  myVotes: number[];
  canClose: boolean;
  options: PollOption[];
};

/** Отложенное сообщение: ждёт sendAt и уходит само. Только текст. */
export type ScheduledKind = 'dm' | 'chat' | 'channel';
export type Scheduled = { id: number; kind: ScheduledKind; body: string; sendAt: string; createdAt: string };

export type PollInput = { question: string; options: string[]; multiple?: boolean; anonymous?: boolean };

export type ChannelPost = {
  id: number;
  channelId: number;
  body: string;
  createdAt: string;
  editedAt: string | null;
  views: number;
  commentCount: number;
  attachment: Attachment | null;
  reactions: Reaction[];
  poll?: Poll | null;
};

export type ChannelSummary = Channel & ChatPrefs & { unread: number; lastPost: ChannelPost | null };

export type ChannelComment = { id: number; body: string; createdAt: string; author: Author };

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

/** Настройки чата в списке — у каждого свои: закреплён ли и приглушён ли. */
export type ChatPrefs = { pinnedAt: string | null; muted: boolean };
export type PrefKind = 'dm' | 'chat' | 'channel';

/** Чат в правилах папки: вид и id — собеседника, чата или канала. */
export type ChatRef = { kind: PrefKind; id: number };

/** Папка чатов: виды, добавленные и исключённые вручную, два фильтра. */
export type ChatFolder = {
  id: number;
  title: string;
  types: PrefKind[];
  include: ChatRef[];
  exclude: ChatRef[];
  excludeMuted: boolean;
  excludeRead: boolean;
};

export type FolderInput = Partial<Omit<ChatFolder, 'id'>>;

/** Кому видно время захода: всем, тем, на кого я подписан, никому. */
export type LastSeenPrivacy = 'all' | 'follows' | 'nobody';

export type AccountSettings = {
  email: string | null;
  /** Номер в формате E.164 или null. */
  phone: string | null;
  /** Есть ли пароль: у аккаунта по номеру — это двухэтапная проверка. */
  hasPassword: boolean;
  /** Входит ли по логину и паролю — только старые аккаунты, созданные до входа по номеру. */
  passwordLogin: boolean;
  lastSeen: LastSeenPrivacy;
  createdAt: string;
};

/** Код отправлен: через сколько секунд он сгорит и когда можно попросить новый. */
export type CodeSent = { ok: true; phone: string; expiresIn: number; resendIn: number; demoCode?: string };

/** Что дальше после верного кода: войти, ввести пароль или придумать логин. */
export type PhoneVerdict =
  | { status: 'signed-in'; user: User }
  | { status: 'password'; ticket: string }
  | { status: 'signup'; ticket: string };

/** Открытый вход в аккаунт. Токена здесь нет и не будет — только номер. */
export type Session = { id: number; current: boolean; createdAt: string; userAgent: string | null };

export type Conversation = ChatPrefs & {
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
  | 'chat_invite'
  /** Упомянули через @ в группе — приходит и из приглушённого чата. */
  | 'mention';

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
  /** Сообщение группы, где упомянули, — у события «mention». */
  message: NotificationRef | null;
};

/** Три счётчика одним запросом — иначе оболочка опрашивала бы три эндпоинта. */
export type Badges = { messages: number; chats: number; channels: number; notifications: number };

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
  poll?: Poll | null;
};

export type ChatSummary = Chat & ChatPrefs & {
  unread: number;
  /** Непрочитанные сообщения, где упомянут смотрящий, — значок «@» в списке. */
  mentions: number;
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

  // ─ Вход по номеру: номер → код → (пароль | логин и имя) ────────────

  phoneStart: (phone: string) => request<CodeSent>('/auth/phone/start', { method: 'POST', body: body({ phone }) }),

  phoneVerify: (phone: string, code: string) =>
    request<PhoneVerdict>('/auth/phone/verify', { method: 'POST', body: body({ phone, code }) }),

  phonePassword: (ticket: string, password: string) =>
    request<{ user: User }>('/auth/phone/password', { method: 'POST', body: body({ ticket, password }) }),

  phoneSignup: (ticket: string, username: string, displayName: string) =>
    request<{ user: User }>('/auth/phone/signup', { method: 'POST', body: body({ ticket, username, displayName }) }),

  /** Вход по логину и паролю — только для аккаунтов, созданных до входа по номеру. */
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
      pinned: PinnedPreview | null;
    }>(
      `/messages/${encodeURIComponent(username)}${qs}`,
    );
  },

  sendMessage: (username: string, text: string, replyTo?: number | null) =>
    request<{ message: Message }>(`/messages/${encodeURIComponent(username)}`, {
      method: 'POST',
      body: body({ body: text, replyTo: replyTo ?? undefined }),
    }),

  sendAttachment: (username: string, input: AttachmentInput) =>
    request<{ message: Message }>(`/messages/${encodeURIComponent(username)}`, {
      method: 'POST',
      body: attachmentForm(input),
    }),

  editMessage: (username: string, id: number, text: string) =>
    request<{ message: Message }>(`/messages/${encodeURIComponent(username)}/${id}`, {
      method: 'PATCH',
      body: body({ body: text }),
    }),

  deleteMessage: (username: string, id: number) =>
    request<{ ok: true }>(`/messages/${encodeURIComponent(username)}/${id}`, { method: 'DELETE' }),

  /** `null` — снять свою реакцию. */
  searchThread: (username: string, q: string) =>
    request<{ results: ConversationHit[] }>(`/messages/${encodeURIComponent(username)}/search?q=${encodeURIComponent(q)}`),

  searchChat: (chatId: number, q: string) =>
    request<{ results: ConversationHit[] }>(`/chats/${chatId}/search?q=${encodeURIComponent(q)}`),

  searchChannel: (handle: string, q: string) =>
    request<{ results: ConversationHit[] }>(`/channels/${encodeURIComponent(handle)}/search?q=${encodeURIComponent(q)}`),

  pinMessage: (username: string, id: number) =>
    request<{ pinned: PinnedPreview | null }>(`/messages/${encodeURIComponent(username)}/${id}/pin`, { method: 'PUT' }),

  unpinMessage: (username: string) =>
    request<{ ok: true }>(`/messages/${encodeURIComponent(username)}/pin`, { method: 'DELETE' }),

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
      pinned: PinnedPreview | null;
    }>(
      `/chats/${id}/messages${qs}`,
    );
  },

  sendChatMessage: (id: number, text: string, replyTo?: number | null) =>
    request<{ message: ChatMessage }>(`/chats/${id}/messages`, {
      method: 'POST',
      body: body({ body: text, replyTo: replyTo ?? undefined }),
    }),

  sendChatAttachment: (chatId: number, input: AttachmentInput) =>
    request<{ message: ChatMessage }>(`/chats/${chatId}/messages`, {
      method: 'POST',
      body: attachmentForm(input),
    }),

  editChatMessage: (chatId: number, id: number, text: string) =>
    request<{ message: ChatMessage }>(`/chats/${chatId}/messages/${id}`, {
      method: 'PATCH',
      body: body({ body: text }),
    }),

  deleteChatMessage: (chatId: number, id: number) =>
    request<{ ok: true }>(`/chats/${chatId}/messages/${id}`, { method: 'DELETE' }),

  pinChatMessage: (chatId: number, id: number) =>
    request<{ pinned: PinnedPreview | null }>(`/chats/${chatId}/messages/${id}/pin`, { method: 'PUT' }),

  unpinChatMessage: (chatId: number) => request<{ ok: true }>(`/chats/${chatId}/pin`, { method: 'DELETE' }),

  reactChatMessage: (chatId: number, id: number, emoji: string | null) =>
    request<{ message: ChatMessage }>(`/chats/${chatId}/messages/${id}/reaction`, {
      method: emoji ? 'PUT' : 'DELETE',
      body: emoji ? body({ emoji }) : undefined,
    }),

  chatTyping: (id: number) => request<{ ok: true }>(`/chats/${id}/typing`, { method: 'PUT' }),

  // ─ Каналы ───────────────────────────────────────────────────────────────

  channels: () => request<{ channels: ChannelSummary[]; unreadTotal: number }>('/channels'),

  // ─ Пуш-уведомления ────────────────────────────────────────────────────

  /** Открытый ключ VAPID сервера — нужен браузеру для подписки. */
  pushKey: () => request<{ publicKey: string }>('/push/key'),

  /** Подписка этого устройства — как её отдаёт PushSubscription.toJSON(). */
  savePushSubscription: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ ok: true }>('/push/subscription', { method: 'PUT', body: body(subscription) }),

  deletePushSubscription: (endpoint: string) =>
    request<{ ok: true }>('/push/subscription', { method: 'DELETE', body: body({ endpoint }) }),

  // ─ Стикеры ────────────────────────────────────────────────────────────

  sendSticker: (username: string, sticker: string) =>
    request<{ message: Message }>(`/messages/${encodeURIComponent(username)}`, { method: 'POST', body: body({ sticker }) }),

  sendChatSticker: (chatId: number, sticker: string) =>
    request<{ message: ChatMessage }>(`/chats/${chatId}/messages`, { method: 'POST', body: body({ sticker }) }),

  // ─ Отложенные ──────────────────────────────────────────────────────────

  /** target — логин собеседника, номер группы или адрес канала. */
  scheduled: (kind: ScheduledKind, target: string | number) =>
    request<{ scheduled: Scheduled[] }>(`/scheduled?kind=${kind}&target=${encodeURIComponent(String(target))}`),

  schedule: (kind: ScheduledKind, target: string | number, text: string, sendAt: string) =>
    request<{ scheduled: Scheduled }>('/scheduled', { method: 'POST', body: body({ kind, target, body: text, sendAt }) }),

  updateScheduled: (id: number, input: { body?: string; sendAt?: string }) =>
    request<{ scheduled: Scheduled }>(`/scheduled/${id}`, { method: 'PATCH', body: body(input) }),

  deleteScheduled: (id: number) => request<{ ok: true }>(`/scheduled/${id}`, { method: 'DELETE' }),

  sendScheduledNow: (id: number) => request<{ ok: true; messageId: number }>(`/scheduled/${id}/send`, { method: 'POST' }),

  // ─ Опросы ──────────────────────────────────────────────────────────────

  sendChatPoll: (chatId: number, poll: PollInput) =>
    request<{ message: ChatMessage }>(`/chats/${chatId}/messages`, { method: 'POST', body: body({ poll }) }),

  publishPoll: (handle: string, poll: PollInput) =>
    request<{ post: ChannelPost }>(`/channels/${encodeURIComponent(handle)}/posts`, { method: 'POST', body: body({ poll }) }),

  /** Голос целиком: все выбранные варианты; пустой список — отозвать голос. */
  votePoll: (pollId: number, options: number[]) =>
    request<{ poll: Poll }>(`/polls/${pollId}/vote`, { method: 'PUT', body: body({ options }) }),

  closePoll: (pollId: number) => request<{ poll: Poll }>(`/polls/${pollId}/close`, { method: 'PUT' }),

  // ─ Аккаунт ─────────────────────────────────────────────────────────────

  account: () => request<AccountSettings>('/account'),

  setLastSeen: (lastSeen: LastSeenPrivacy) =>
    request<{ lastSeen: LastSeenPrivacy }>('/account/privacy', { method: 'PUT', body: body({ lastSeen }) }),

  linkPhoneStart: (phone: string) => request<CodeSent>('/account/phone/start', { method: 'POST', body: body({ phone }) }),

  linkPhone: (phone: string, code: string) =>
    request<{ phone: string }>('/account/phone', { method: 'PUT', body: body({ phone, code }) }),

  unlinkPhone: () => request<{ phone: null }>('/account/phone', { method: 'DELETE' }),

  /** Выключить двухэтапную проверку — только у аккаунта по номеру. */
  removePassword: (currentPassword: string) =>
    request<{ ok: true }>('/account/password', { method: 'DELETE', body: body({ currentPassword }) }),

  /** Задать пароль впервые (текущего нет — пустая строка) или сменить по текущему. */
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true; ended: number }>('/account/password', { method: 'PUT', body: body({ currentPassword, newPassword }) }),

  sessions: () => request<{ sessions: Session[] }>('/account/sessions'),

  endSession: (id: number) => request<{ ok: true }>(`/account/sessions/${id}`, { method: 'DELETE' }),

  endOtherSessions: () => request<{ ok: true; ended: number }>('/account/sessions', { method: 'DELETE' }),

  /** Код на свой номер для удаления аккаунта без пароля. */
  deleteCode: () => request<CodeSent>('/account/delete-code', { method: 'POST' }),

  /** Удалить: паролем, а если его нет — кодом из SMS. */
  deleteAccount: (proof: { password: string } | { code: string }) =>
    request<{ ok: true }>('/account', { method: 'DELETE', body: body(proof) }),

  folders: () => request<{ folders: ChatFolder[] }>('/folders'),

  createFolder: (input: FolderInput) =>
    request<{ folder: ChatFolder }>('/folders', { method: 'POST', body: body(input) }),

  updateFolder: (id: number, input: FolderInput) =>
    request<{ folder: ChatFolder }>(`/folders/${id}`, { method: 'PATCH', body: body(input) }),

  deleteFolder: (id: number) => request<{ ok: true }>(`/folders/${id}`, { method: 'DELETE' }),

  reorderFolders: (ids: number[]) =>
    request<{ folders: ChatFolder[] }>('/folders/order', { method: 'PUT', body: body({ ids }) }),

  /** Закрепить чат или выключить уведомления. target — логин, номер чата или адрес канала. */
  setPref: (kind: PrefKind, target: string | number, input: { pinned?: boolean; muted?: boolean }) =>
    request<{ pinned: boolean; muted: boolean }>(`/prefs/${kind}/${encodeURIComponent(String(target))}`, {
      method: 'PUT',
      body: body(input),
    }),

  searchChannels: (q: string) =>
    request<{ channels: Channel[] }>(`/channels/search?q=${encodeURIComponent(q)}`),

  createChannel: (input: { title: string; handle: string; description: string }) =>
    request<{ channel: Channel }>('/channels', { method: 'POST', body: body(input) }),

  channel: (handle: string) => request<{ channel: Channel }>(`/channels/${encodeURIComponent(handle)}`),

  updateChannel: (handle: string, input: { title?: string; description?: string }) =>
    request<{ channel: Channel }>(`/channels/${encodeURIComponent(handle)}`, { method: 'PATCH', body: body(input) }),

  deleteChannel: (handle: string) =>
    request<{ ok: true }>(`/channels/${encodeURIComponent(handle)}`, { method: 'DELETE' }),

  subscribe: (handle: string, on: boolean) =>
    request<{ channel: Channel }>(`/channels/${encodeURIComponent(handle)}/subscription`, {
      method: on ? 'PUT' : 'DELETE',
    }),

  markChannelRead: (handle: string) =>
    request<{ ok: true }>(`/channels/${encodeURIComponent(handle)}/read`, { method: 'PUT' }),

  channelPosts: (handle: string, cursor?: number | null) =>
    request<{ channel: Channel; posts: ChannelPost[]; nextCursor: number | null; pinned: PinnedPreview | null }>(
      `/channels/${encodeURIComponent(handle)}/posts${cursor != null ? `?cursor=${cursor}` : ''}`,
    ),

  /** Публикация: текст, файл или голосовое — multipart, как в переписке. */
  publish: (handle: string, input: { body: string } | AttachmentInput) =>
    request<{ post: ChannelPost }>(`/channels/${encodeURIComponent(handle)}/posts`, {
      method: 'POST',
      body: 'file' in input ? attachmentForm(input) : body(input),
    }),

  editPost: (handle: string, id: number, text: string) =>
    request<{ post: ChannelPost }>(`/channels/${encodeURIComponent(handle)}/posts/${id}`, {
      method: 'PATCH',
      body: body({ body: text }),
    }),

  deleteChannelPost: (handle: string, id: number) =>
    request<{ ok: true }>(`/channels/${encodeURIComponent(handle)}/posts/${id}`, { method: 'DELETE' }),

  pinPost: (handle: string, id: number) =>
    request<{ pinned: PinnedPreview | null }>(`/channels/${encodeURIComponent(handle)}/posts/${id}/pin`, { method: 'PUT' }),

  unpinPost: (handle: string) =>
    request<{ ok: true }>(`/channels/${encodeURIComponent(handle)}/pin`, { method: 'DELETE' }),

  reactPost: (handle: string, id: number, emoji: string | null) =>
    request<{ post: ChannelPost }>(`/channels/${encodeURIComponent(handle)}/posts/${id}/reaction`, {
      method: emoji ? 'PUT' : 'DELETE',
      body: emoji ? body({ emoji }) : undefined,
    }),

  channelComments: (handle: string, postId: number) =>
    request<{ channel: Channel; post: ChannelPost; comments: ChannelComment[]; canComment: boolean }>(
      `/channels/${encodeURIComponent(handle)}/posts/${postId}/comments`,
    ),

  addChannelComment: (handle: string, postId: number, text: string) =>
    request<{ comment: ChannelComment }>(`/channels/${encodeURIComponent(handle)}/posts/${postId}/comments`, {
      method: 'POST',
      body: body({ body: text }),
    }),

  deleteChannelComment: (handle: string, postId: number, id: number) =>
    request<{ ok: true }>(`/channels/${encodeURIComponent(handle)}/posts/${postId}/comments/${id}`, {
      method: 'DELETE',
    }),

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
  ? mockApi
  : realApi;
