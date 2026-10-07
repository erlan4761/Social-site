import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { Composer } from './components/Composer';

vi.mock('./session', () => ({
  useSession: () => ({ user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null } }),
}));

describe('черновик записи', () => {
  afterEach(() => vi.useRealTimers());

  it('подставляется в пустое поле с подсказкой; «Очистить» убирает и поле, и черновик', async () => {
    vi.spyOn(api, 'postDraft').mockResolvedValue({ draft: { body: 'Начал про плёнку', updatedAt: new Date().toISOString() } });
    const save = vi.spyOn(api, 'savePostDraft').mockResolvedValue({ draft: null });
    render(<Composer onPublished={() => undefined} />);
    expect(await screen.findByDisplayValue('Начал про плёнку')).toBeInTheDocument();
    expect(screen.getByText(/Черновик с прошлого раза/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Очистить' }));
    expect(screen.getByLabelText('Новый пост')).toHaveValue('');
    expect(save).toHaveBeenCalledWith('');
    expect(screen.queryByText(/Черновик с прошлого раза/)).toBeNull();
  });

  it('по паузе в наборе — сохраняется; опубликовали — пустое заново не шлётся', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'postDraft').mockResolvedValue({ draft: null });
    const save = vi.spyOn(api, 'savePostDraft').mockResolvedValue({ draft: null });
    save.mockClear();
    vi.spyOn(api, 'createPost').mockResolvedValue({ post: { id: 9 } as never });
    render(<Composer onPublished={() => undefined} />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('Новый пост'), { target: { value: 'Пишу' } });
    await act(async () => {
      vi.advanceTimersByTime(1300);
    });
    expect(save).toHaveBeenLastCalledWith('Пишу');
    save.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }));
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(save).not.toHaveBeenCalled();
  });
});
