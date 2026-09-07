export type User = {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  createdAt: string;
  postCount?: number;
  followerCount?: number;
  followingCount?: number;
  followedByMe?: boolean;
};

type Author = { id: number; username: string; displayName: string };

export type Post = {
  id: number;
  body: string;
  createdAt: string;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
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
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
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

export const api = {
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

  createPost: (text: string) =>
    request<{ post: Post }>('/posts', { method: 'POST', body: body({ body: text }) }),

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

  setFollow: (username: string, following: boolean) =>
    request<{ followedByMe: boolean; followerCount: number }>(
      `/users/${encodeURIComponent(username)}/follow`,
      { method: following ? 'PUT' : 'DELETE' },
    ),
};
