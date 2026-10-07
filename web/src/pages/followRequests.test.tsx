import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { FollowRequests } from './FollowRequests';

const asker = (id: number, username: string, displayName: string) => ({
  id, username, displayName, avatarUrl: null, bio: '', createdAt: '2026-01-01T00:00:00.000Z', requestedAt: new Date().toISOString(),
});

describe('заявки на подписку', () => {
  it('принять и отклонить — строка уходит из списка', async () => {
    vi.spyOn(api, 'followRequests').mockResolvedValue({ users: [asker(2, 'nina', 'Нина'), asker(3, 'oleg_k', 'Олег')] });
    const accept = vi.spyOn(api, 'acceptFollowRequest').mockResolvedValue({ ok: true, followerCount: 1 });
    const decline = vi.spyOn(api, 'declineFollowRequest').mockResolvedValue({ ok: true });
    render(
      <MemoryRouter>
        <FollowRequests />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Нина')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Принять' })[0]);
    });
    expect(accept).toHaveBeenCalledWith('nina');
    expect(screen.queryByText('Нина')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Отклонить заявку Олег' }));
    });
    expect(decline).toHaveBeenCalledWith('oleg_k');
    expect(screen.getByText('Новых заявок нет.')).toBeInTheDocument();
  });
});
