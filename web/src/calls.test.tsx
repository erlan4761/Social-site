import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { CallProvider } from './calls';
import { dispatchLive } from './live';

/**
 * Входящий звонок глазами человека. Само соединение (WebRTC) в jsdom не
 * проверить — здесь то, что видно и нажимается: вызов, «Отклонить», отмена
 * звонящим.
 */

const ring = (id: string) =>
  act(() =>
    dispatchLive({
      t: 'call',
      kind: 'ring',
      id,
      video: false,
      sdp: { type: 'offer', sdp: 'v=0' },
      from: { id: 7, username: 'nina', displayName: 'Нина Барто', avatarUrl: null },
    }),
  );

afterEach(() => vi.restoreAllMocks());

describe('входящий звонок', () => {
  it('показывает, кто звонит; «Отклонить» кладёт трубку на сервере', async () => {
    const end = vi.spyOn(api, 'endCall').mockResolvedValue({ ok: true, reason: 'declined' });
    render(<CallProvider><p>экран</p></CallProvider>);
    ring('call-1');
    expect(screen.getByRole('dialog', { name: 'Звонок: Нина Барто' })).toBeInTheDocument();
    expect(screen.getByText('Входящий звонок')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
    expect(end).toHaveBeenCalledWith('call-1');
    expect(screen.getByText('Звонок отклонён')).toBeInTheDocument();
  });

  it('звонящий передумал — «Звонок отменён», кнопок больше нет', () => {
    render(<CallProvider><p>экран</p></CallProvider>);
    ring('call-2');
    act(() => dispatchLive({ t: 'call', kind: 'end', id: 'call-2', reason: 'cancelled' }));
    expect(screen.getByText('Звонок отменён')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Принять' })).toBeNull();
  });

  it('конец чужого звонка текущий не трогает', () => {
    render(<CallProvider><p>экран</p></CallProvider>);
    ring('call-3');
    act(() => dispatchLive({ t: 'call', kind: 'end', id: 'другой', reason: 'hangup' }));
    expect(screen.getByRole('button', { name: 'Принять' })).toBeInTheDocument();
  });
});
