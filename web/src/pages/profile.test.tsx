import { render, screen, within } from '@testing-library/react';
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
