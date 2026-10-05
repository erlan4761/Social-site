import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type Post } from '../api';
import { PostRow } from './PostRow';

vi.mock('../session', () => ({
  useSession: () => ({ user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null } }),
}));

const post = (patch: Partial<Post> = {}): Post => ({
  id: 5, body: 'Проявил плёнку', createdAt: new Date().toISOString(), editedAt: null, likeCount: 0, commentCount: 0,
  likedByMe: false, bookmarkedByMe: false, media: null,
  author: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null }, ...patch,
});

const show = (p: Post, onPatch = vi.fn()) => {
  render(
    <MemoryRouter>
      <PostRow post={p} canDelete onDelete={() => undefined} onPatch={onPatch} />
    </MemoryRouter>,
  );
  return onPatch;
};

describe('правка записи', () => {
  it('своя свежая — «Изменить», правка на месте, «Сохранить» отправляет и обновляет', async () => {
    const update = vi.spyOn(api, 'updatePost').mockResolvedValue({ post: post({ body: 'Проявил две плёнки', editedAt: new Date().toISOString() }) });
    const onPatch = show(post());
    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    const field = screen.getByLabelText('Текст записи');
    expect(field).toHaveValue('Проявил плёнку');
    fireEvent.change(field, { target: { value: 'Проявил две плёнки' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    });
    expect(update).toHaveBeenCalledWith(5, 'Проявил две плёнки');
    expect(onPatch).toHaveBeenCalledWith(5, expect.objectContaining({ body: 'Проявил две плёнки' }));
    expect(screen.queryByLabelText('Текст записи')).toBeNull();
  });

  it('Esc — отмена без запроса; пустой текст не сохранить', () => {
    const update = vi.spyOn(api, 'updatePost');
    update.mockClear();
    show(post());
    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    fireEvent.change(screen.getByLabelText('Текст записи'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Текст записи'), { key: 'Escape' });
    expect(screen.queryByLabelText('Текст записи')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('старше двух суток и чужая — без «Изменить»; изменённая — с пометкой', () => {
    show(post({ createdAt: new Date(Date.now() - 49 * 3_600_000).toISOString(), editedAt: new Date().toISOString() }));
    expect(screen.queryByRole('button', { name: 'Изменить' })).toBeNull();
    expect(screen.getByText('изменено')).toBeInTheDocument();
  });

  it('чужая запись — без «Изменить»', () => {
    show(post({ author: { id: 2, username: 'nina', displayName: 'Нина', avatarUrl: null } }));
    expect(screen.queryByRole('button', { name: 'Изменить' })).toBeNull();
  });
});
