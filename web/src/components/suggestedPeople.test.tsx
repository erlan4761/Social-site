import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Suggestion } from '../api';
import { SuggestedPeople } from './SuggestedPeople';

vi.mock('../session', () => ({
  useSession: () => ({ user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null } }),
}));

const person = (id: number, username: string, displayName: string, patch: Partial<Suggestion> = {}): Suggestion => ({
  id, username, displayName, avatarUrl: null, bio: '', createdAt: '2026-01-01T00:00:00.000Z', followedByMe: false,
  followerCount: 0, mutualCount: 0, mutualName: null, ...patch,
});

const show = () =>
  render(
    <MemoryRouter>
      <SuggestedPeople variant="plain" />
    </MemoryRouter>,
  );

describe('кого почитать', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // нет хранилища — и не надо
    }
  });

  it('подпись — кого читают ваши подписки или сколько читателей; подписка прямо в списке', async () => {
    vi.spyOn(api, 'suggestions').mockResolvedValue({
      users: [
        person(2, 'marina', 'Марина', { mutualCount: 3, mutualName: 'Нина' }),
        person(3, 'oleg_k', 'Олег', { mutualCount: 1, mutualName: 'Нина' }),
        person(4, 'pavel', 'Павел', { followerCount: 5 }),
      ],
    });
    const follow = vi.spyOn(api, 'setFollow').mockResolvedValue({ followedByMe: true, followerCount: 1 });
    show();
    expect(await screen.findByText('Читают Нина и ещё 2')).toBeInTheDocument();
    expect(screen.getByText('Читает Нина')).toBeInTheDocument();
    expect(screen.getByText('5 подписчиков')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Подписаться на Олег' }));
    });
    expect(follow).toHaveBeenCalledWith('oleg_k', true);
    expect(screen.getByRole('button', { name: 'Отписаться от Олег' })).toHaveTextContent('Вы подписаны');
  });

  it('«Скрыть» прячет блок и не просит подсказки при следующем показе', async () => {
    const load = vi.spyOn(api, 'suggestions').mockResolvedValue({ users: [person(2, 'marina', 'Марина')] });
    const { unmount } = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Скрыть' }));
    expect(screen.queryByRole('heading', { name: 'Кого почитать' })).toBeNull();
    unmount();
    load.mockClear();
    show();
    expect(screen.queryByRole('heading', { name: 'Кого почитать' })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('пусто — блока нет', async () => {
    const load = vi.spyOn(api, 'suggestions').mockResolvedValue({ users: [] });
    show();
    await act(async () => {
      await load.mock.results[0]?.value;
    });
    expect(screen.queryByRole('heading', { name: 'Кого почитать' })).toBeNull();
  });
});
