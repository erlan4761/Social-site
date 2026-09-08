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
};

export type Author = { id: number; username: string; displayName: string; avatarUrl: string | null };

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

export type Message = {
  id: number;
  body: string;
  createdAt: string;
  fromId: number;
  toId: number;
  readAt: string | null;
};

export type Conversation = {
  user: Author;
  unread: number;
  lastMessage: Message;
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

  register: (input: { username: string; displayName: string; password: string }) =>
    request<{ user: User }>('/auth/register', { method: 'POST', body: body(input) }),

  login: (input: { username: string; password: string }) =>
    request<{ user: User }>('/auth/login', { method: 'POST', body: body(input) }),

  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),

  profile: (username: string) =>
    request<{ user: User }>(`/users/${encodeURIComponent(username)}`),

  updateProfile: (input: { displayName: string; bio: string }) =>
    request<{ user: User }>('/users/me', { method: 'PATCH', body: body(input) }),

  posts: (opts: { author?: string; cursor?: number | null; feed?: 'following' } = {}) => {
    const params = new URLSearchParams();
    if (opts.author) params.set('author', opts.author);
    if (opts.cursor != null) params.set('cursor', String(opts.cursor));
    if (opts.feed) params.set('feed', opts.feed);
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

  thread: (username: string, cursor?: number | null) => {
    const qs = cursor != null ? `?cursor=${cursor}` : '';
    return request<{ user: Author; messages: Message[]; nextCursor: number | null }>(
      `/messages/${encodeURIComponent(username)}${qs}`,
    );
  },

  sendMessage: (username: string, text: string) =>
    request<{ message: Message }>(`/messages/${encodeURIComponent(username)}`, {
      method: 'POST',
      body: body({ body: text }),
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
