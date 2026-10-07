import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type Post } from '../api';
import { Profile } from './Profile';

vi.mock('../session', () => ({
  useSession: () => ({
    user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null },
    setUser: () => undefined,
    refreshBadges: () => undefined,
  }),
}));

const nina = { id: 2, username: 'nina', displayName: 'Нина', avatarUrl: null };
const post = (id: number, body: string, patch: Partial<Post> = {}): Post => ({
  id, body, createdAt: new Date().toISOString(), editedAt: null, likeCount: 0, commentCount: 0,
  likedByMe: false, bookmarkedByMe: false, media: null, author: nina, ...patch,
});

describe('профиль: закреплённая запись', () => {
  it('наверху с пометкой и не повторяется в ленте ниже', async () => {
    vi.spyOn(api, 'profile').mockResolvedValue({
      user: { ...nina, bio: '', createdAt: '2026-01-01T00:00:00.000Z', postCount: 3, followerCount: 0, followingCount: 0 },
      pinnedPost: post(1, 'Обо мне', { pinned: true }),
    });
    vi.spyOn(api, 'archive').mockResolvedValue({ months: [], total: 3 });
    vi.spyOn(api, 'posts').mockResolvedValue({
      posts: [post(3, 'Свежая'), post(2, 'Вчерашняя'), post(1, 'Обо мне', { pinned: true })],
      nextCursor: null,
    });
    render(
      <MemoryRouter initialEntries={['/u/nina']}>
        <Routes>
          <Route path="/u/:username" element={<Profile />} />
        </Routes>
      </MemoryRouter>,
    );
    const rows = await screen.findAllByRole('article');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('Закреплённая запись')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Обо мне')).toBeInTheDocument();
    expect(screen.getAllByText('Обо мне')).toHaveLength(1);
    expect(within(rows[1]).getByText('Свежая')).toBeInTheDocument();
  });
});

describe('профиль: закрытый', () => {
  it('чужой закрытый — замок, объяснение вместо записей, кнопка заявки', async () => {
    vi.spyOn(api, 'profile').mockResolvedValue({
      user: {
        ...nina, bio: '', createdAt: '2026-01-01T00:00:00.000Z', postCount: 4, followerCount: 2, followingCount: 0,
        private: true, canSeePosts: false, requestedByMe: false, followedByMe: false,
      },
      pinnedPost: null,
    });
    vi.spyOn(api, 'archive').mockResolvedValue({ months: [], total: 0 });
    vi.spyOn(api, 'posts').mockResolvedValue({ posts: [], nextCursor: null });
    const follow = vi.spyOn(api, 'setFollow').mockResolvedValue({ followedByMe: false, requested: true, followerCount: 2 });
    render(
      <MemoryRouter initialEntries={['/u/nina']}>
        <Routes>
          <Route path="/u/:username" element={<Profile />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('img', { name: 'Закрытый профиль' })).toBeInTheDocument();
    expect(await screen.findByText('Это закрытый профиль.')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Попросить подписку' }));
    });
    expect(follow).toHaveBeenCalledWith('nina', true);
    expect(screen.getByRole('button', { name: 'Заявка отправлена' })).toBeInTheDocument();
    expect(screen.getByText(/Заявка отправлена — записи откроются/)).toBeInTheDocument();
    expect(screen.getByText(/2 подписчика/)).toBeInTheDocument();
  });
});

describe('профиль: обложка и ссылки', () => {
  const me = {
    id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null, bio: 'Снимаю', createdAt: '2026-01-01T00:00:00.000Z',
    postCount: 0, followerCount: 5, followingCount: 2, coverUrl: '/uploads/media/cover.png', links: ['https://t.me/erlan'],
  };
  const open = () =>
    render(
      <MemoryRouter initialEntries={['/u/demo']}>
        <Routes>
          <Route path="/u/:username" element={<Profile />} />
        </Routes>
      </MemoryRouter>,
    );

  it('обложка и ссылки видны; правка сохраняет ссылки и не теряет счётчики', async () => {
    vi.spyOn(api, 'profile').mockResolvedValue({ user: me, pinnedPost: null });
    vi.spyOn(api, 'archive').mockResolvedValue({ months: [], total: 0 });
    vi.spyOn(api, 'posts').mockResolvedValue({ posts: [], nextCursor: null });
    // Ответ правки — как с сервера: без счётчиков профиля вовсе (JSON не несёт undefined).
    const { followerCount: _f, followingCount: _g, postCount: _p, ...plain } = me;
    const update = vi.spyOn(api, 'updateProfile').mockResolvedValue({
      user: { ...plain, links: ['https://t.me/erlan', 'https://example.com/'] },
    });
    const { container } = open();
    const link = await screen.findByRole('link', { name: 't.me/erlan' });
    expect(link).toHaveAttribute('href', 'https://t.me/erlan');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(container.querySelector('.profile-cover')).toHaveAttribute('src', '/uploads/media/cover.png');

    fireEvent.click(screen.getByRole('button', { name: 'Редактировать профиль' }));
    fireEvent.change(screen.getByLabelText('Ссылка 2'), { target: { value: 'example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    });
    expect(update).toHaveBeenCalledWith({ displayName: 'Ерлан', bio: 'Снимаю', links: ['https://t.me/erlan', 'https://example.com/'] });
    expect(await screen.findByRole('link', { name: 'example.com' })).toBeInTheDocument();
    expect(screen.getByText(/5 подписчиков/)).toBeInTheDocument();
  });

  it('негодная ссылка — ошибка без запроса', async () => {
    vi.spyOn(api, 'profile').mockResolvedValue({ user: me, pinnedPost: null });
    vi.spyOn(api, 'archive').mockResolvedValue({ months: [], total: 0 });
    vi.spyOn(api, 'posts').mockResolvedValue({ posts: [], nextCursor: null });
    const update = vi.spyOn(api, 'updateProfile');
    update.mockClear();
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Редактировать профиль' }));
    fireEvent.change(screen.getByLabelText('Ссылка 2'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText(/только на сайт/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });
});
