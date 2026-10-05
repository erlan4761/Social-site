import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type Post } from '../api';
import { TagPage } from './TagPage';

vi.mock('../session', () => ({
  useSession: () => ({ user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null } }),
}));

const open = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tag/:tag" element={<TagPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('страница тега', () => {
  it('лента по ключу тега, шапка — подпись с «ё», популярные — без текущего', async () => {
    const posts = vi.spyOn(api, 'posts').mockResolvedValue({
      posts: [{
        id: 5, body: 'Проявил #плёнка', createdAt: new Date().toISOString(), editedAt: null, likeCount: 0, commentCount: 0,
        likedByMe: false, bookmarkedByMe: false, media: null,
        author: { id: 2, username: 'nina', displayName: 'Нина', avatarUrl: null },
      } as Post],
      nextCursor: null,
    });
    vi.spyOn(api, 'tagInfo').mockResolvedValue({ tag: 'пленка', label: 'плёнка', count: 1 });
    vi.spyOn(api, 'trendingTags').mockResolvedValue({ tags: [{ tag: 'пленка', label: 'плёнка', count: 1 }, { tag: 'ночь', label: 'ночь', count: 3 }] });
    open(`/tag/${encodeURIComponent('#ПЛЕНКА')}`);
    expect(await screen.findByRole('heading', { name: '#плёнка' })).toBeInTheDocument();
    expect(posts).toHaveBeenCalledWith(expect.objectContaining({ tag: 'пленка' }));
    expect(await screen.findByText(/1 запись с этим тегом/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /#ночь/ })).toHaveAttribute('href', `/tag/${encodeURIComponent('ночь')}`);
    expect(screen.queryByRole('link', { name: /^#плёнка\s*1$/ })).toBeNull();
  });

  it('мусор вместо тега — объяснение, без запросов', () => {
    const posts = vi.spyOn(api, 'posts');
    posts.mockClear();
    open('/tag/1');
    expect(screen.getByRole('heading', { name: 'Такого тега нет' })).toBeInTheDocument();
    expect(posts).not.toHaveBeenCalled();
  });
});
