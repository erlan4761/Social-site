import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type FollowEntry } from '../api';
import { FollowListDialog } from './FollowListDialog';

vi.mock('../session', () => ({
  useSession: () => ({ user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null } }),
}));

HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.open = false; };

const person = (id: number, name: string, followedByMe = false): FollowEntry => ({
  id, username: `u${id}`, displayName: name, avatarUrl: null, bio: '', createdAt: '2026-01-01T00:00:00Z', followedByMe,
});

describe('подписчики и подписки', () => {
  it('вкладки, «Показать ещё», подписка прямо в списке; себя — без кнопки', async () => {
    vi.spyOn(api, 'followers')
      .mockResolvedValueOnce({ users: [person(2, 'Нина'), person(1, 'Ерлан')], nextCursor: 7 })
      .mockResolvedValueOnce({ users: [person(3, 'Олег', true)], nextCursor: null });
    vi.spyOn(api, 'following').mockResolvedValue({ users: [person(4, 'Марина')], nextCursor: null });
    const setFollow = vi.spyOn(api, 'setFollow').mockResolvedValue({ followedByMe: true, followerCount: 1 });
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <FollowListDialog username="nina" side="followers" counts={{ followers: 3, following: 1 }} onClose={() => undefined} onChanged={onChanged} />
      </MemoryRouter>,
    );
    await screen.findByText('Нина');
    expect(screen.getByRole('tab', { name: /Подписчики 3/ })).toHaveAttribute('aria-selected', 'true');
    // У себя кнопки нет — одна кнопка, у Нины.
    expect(screen.getAllByRole('button', { name: /Подписаться на|Отписаться от/ })).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    });
    expect(api.followers).toHaveBeenLastCalledWith('nina', 7);
    expect(screen.getByRole('button', { name: 'Отписаться от Олег' })).toHaveTextContent('Вы подписаны');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Подписаться на Нина' }));
    });
    expect(setFollow).toHaveBeenCalledWith('u2', true);
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Отписаться от Нина' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Подписки 1/ }));
    });
    expect(await screen.findByText('Марина')).toBeInTheDocument();
  });
});
