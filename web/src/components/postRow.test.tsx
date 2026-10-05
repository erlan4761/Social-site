import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('репосты и цитаты', () => {
  const nina = { id: 2, username: 'nina', displayName: 'Нина', avatarUrl: null };
  const oleg = { id: 3, username: 'oleg_k', displayName: 'Олег', avatarUrl: null };
  const mount = (p: Post, extra: { onDelete?: (id: number) => void; onCreated?: (post: Post) => void } = {}) => {
    const onPatch = vi.fn();
    render(
      <MemoryRouter>
        <PostRow post={p} canDelete onDelete={extra.onDelete ?? (() => undefined)} onPatch={onPatch} onCreated={extra.onCreated} />
      </MemoryRouter>,
    );
    return onPatch;
  };

  it('чистый репост — оригинал с «Репост: Нина»; отметка уходит оригиналу', async () => {
    const like = vi.spyOn(api, 'setLike').mockResolvedValue({ likeCount: 1, likedByMe: true });
    const original = post({ id: 7, body: 'Ночная съёмка', author: oleg });
    const onPatch = mount(post({ id: 20, body: '', author: nina, shared: { kind: 'repost', post: original } }));
    expect(screen.getByText('Ночная съёмка')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Нина' })).toHaveAttribute('href', '/u/nina');
    expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Отметить запись' }));
    });
    expect(like).toHaveBeenCalledWith(7, true);
    expect(onPatch).toHaveBeenLastCalledWith(20, { shared: { kind: 'repost', post: expect.objectContaining({ id: 7, likedByMe: true }) } });
  });

  it('меню: «Сделать репост» — запрос и счётчик', async () => {
    const repost = vi.spyOn(api, 'setRepost').mockResolvedValue({ postId: 5, repostCount: 1, repostedByMe: true });
    const onPatch = mount(post({ author: oleg }));
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Сделать репост' }));
    });
    expect(repost).toHaveBeenCalledWith(5, true);
    expect(onPatch).toHaveBeenLastCalledWith(5, { repostedByMe: true, repostCount: 1 });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('свой репост: «Ваш репост», отмена убирает строку', () => {
    const repost = vi.spyOn(api, 'setRepost');
    repost.mockClear();
    const onDelete = vi.fn();
    const original = post({ id: 7, body: 'Ночная съёмка', author: oleg, repostedByMe: true, repostCount: 1 });
    mount(post({ id: 21, body: '', shared: { kind: 'repost', post: original } }), { onDelete });
    expect(screen.getByText('Ваш репост')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Вы сделали репост/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Отменить репост' }));
    expect(onDelete).toHaveBeenCalledWith(21);
    expect(repost).not.toHaveBeenCalled();
  });

  it('«Цитировать» — окно с текстом и предпросмотром; цитата уходит в ленту', async () => {
    const quote = post({ id: 30, body: 'Согласен', shared: { kind: 'quote', post: post({ author: oleg }) } });
    const create = vi.spyOn(api, 'createPost').mockResolvedValue({ post: quote });
    const onCreated = vi.fn();
    const onPatch = mount(post({ author: oleg }), { onCreated });
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Цитировать' }));
    const dialog = screen.getByRole('dialog', { name: 'Цитировать запись' });
    expect(dialog).toHaveTextContent('Проявил плёнку');
    expect(screen.getByRole('button', { name: 'Опубликовать' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Ваш текст к цитате'), { target: { value: 'Согласен' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }));
    });
    expect(create).toHaveBeenCalledWith('Согласен', null, 5);
    expect(onCreated).toHaveBeenCalledWith(quote);
    expect(onPatch).toHaveBeenCalledWith(5, { repostCount: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('цитата — рамка-ссылка на оригинал; удалённый оригинал — заглушка', () => {
    mount(post({ id: 31, body: 'Смотрите', shared: { kind: 'quote', post: post({ id: 7, body: 'Ночная съёмка', author: oleg }) } }));
    expect(screen.getByRole('link', { name: /Ночная съёмка/ })).toHaveAttribute('href', '/p/7');
    cleanup();
    mount(post({ id: 32, body: 'Смотрите', shared: { kind: 'quote', post: null } }));
    expect(screen.getByText(/Запись недоступна/)).toBeInTheDocument();
  });
});
