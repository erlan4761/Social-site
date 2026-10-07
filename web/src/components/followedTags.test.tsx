import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { FollowedTags, TagFollowButton } from './FollowedTags';

describe('подписка на теги', () => {
  it('кнопка: «Следить за тегом» → «Вы следите», отказ — назад', async () => {
    const follow = vi.spyOn(api, 'setTagFollow').mockResolvedValue({ followedByMe: true });
    render(<TagFollowButton tag="пленка" initial={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Следить за тегом' }));
    });
    expect(follow).toHaveBeenCalledWith('пленка', true);
    expect(screen.getByRole('button', { name: 'Вы следите' })).toHaveAttribute('aria-pressed', 'true');
    follow.mockRejectedValueOnce(new Error('Сервер недоступен'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Вы следите' }));
    });
    expect(screen.getByRole('button', { name: 'Вы следите' })).toBeInTheDocument();
    expect(screen.getByText('Сервер недоступен')).toBeInTheDocument();
  });

  it('строка над «Подписками» — ссылки на отслеживаемые теги; пусто — ничего', async () => {
    vi.spyOn(api, 'followedTags').mockResolvedValueOnce({ tags: [{ tag: 'пленка', label: 'плёнка' }] });
    const { unmount } = render(
      <MemoryRouter>
        <FollowedTags />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('link', { name: '#плёнка' })).toHaveAttribute('href', `/tag/${encodeURIComponent('пленка')}`);
    unmount();
    const empty = vi.spyOn(api, 'followedTags').mockResolvedValueOnce({ tags: [] });
    const { container } = render(
      <MemoryRouter>
        <FollowedTags />
      </MemoryRouter>,
    );
    await act(async () => {
      await empty.mock.results.at(-1)?.value;
    });
    expect(container.textContent).toBe('');
  });
});
