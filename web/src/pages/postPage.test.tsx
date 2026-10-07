import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type Post } from '../api';
import { PostPage } from './PostPage';

vi.mock('../session', () => ({
  useSession: () => ({ user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null } }),
}));

const nina = { id: 2, username: 'nina', displayName: 'Нина', avatarUrl: null };
const part = (id: number, position: number, body: string): Post => ({
  id, body, createdAt: new Date().toISOString(), editedAt: null, likeCount: 0, commentCount: 0, likedByMe: false,
  bookmarkedByMe: false, media: null, author: nina,
  thread: { rootId: 10, position, length: 3, prevId: position > 1 ? id - 1 : null, nextId: position < 3 ? id + 1 : null },
});

describe('страница записи из ветки', () => {
  it('показывает всю ветку по порядку и отмечает открытую', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ post: part(11, 2, 'Вторая') });
    const thread = vi.spyOn(api, 'postThread').mockResolvedValue({ posts: [part(10, 1, 'Первая'), part(11, 2, 'Вторая'), part(12, 3, 'Третья')] });
    vi.spyOn(api, 'comments').mockResolvedValue({ comments: [] });
    const { container } = render(
      <MemoryRouter initialEntries={['/p/11']}>
        <Routes>
          <Route path="/p/:id" element={<PostPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Третья')).toBeInTheDocument();
    expect(thread).toHaveBeenCalledWith(11);
    const items = [...container.querySelectorAll('.thread-item')];
    expect(items.map((x) => x.textContent?.includes('Первая') ? 1 : x.textContent?.includes('Вторая') ? 2 : 3)).toEqual([1, 2, 3]);
    expect(items[1]).toHaveClass('current');
  });
});
