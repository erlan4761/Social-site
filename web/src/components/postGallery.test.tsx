import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, type Media, type Post } from '../api';
import { Composer } from './Composer';
import { PostGallery } from './PostGallery';

vi.mock('../session', () => ({
  useSession: () => ({ user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null } }),
}));

const shot = (name: string, type: Media['type'] = 'image'): Media => ({ url: `/media/${name}`, type, mime: type === 'video' ? 'video/mp4' : 'image/png', name });

describe('галерея записи', () => {
  it('три снимка — сетка «один большой и два малых», нажатие открывает просмотр с листанием', () => {
    const { container } = render(<PostGallery items={[shot('a.png'), shot('b.png'), shot('c.mp4', 'video')]} />);
    expect(container.querySelector('.post-gallery')).toHaveClass('n3');
    expect(screen.getByRole('group', { name: '3 снимка' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть 2 из 3' }));
    const viewer = screen.getByRole('dialog', { name: 'Снимок 2 из 3' });
    expect(viewer.querySelector('img')).toHaveAttribute('src', '/media/b.png');
    fireEvent.click(screen.getByRole('button', { name: 'Следующий снимок' }));
    expect(viewer.querySelector('video')).toHaveAttribute('src', '/media/c.mp4');
    expect(screen.getByText('3 из 3')).toBeInTheDocument();
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    expect(screen.getByText('1 из 3')).toBeInTheDocument();
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' });
    expect(screen.getByText('3 из 3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Открыть оригинал' })).toHaveAttribute('href', '/media/c.mp4');
  });

  it('щелчок по снимку не закрывает, по фону — закрывает', () => {
    render(<PostGallery items={[shot('a.png'), shot('b.png')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть 1 из 2' }));
    const viewer = screen.getByRole('dialog');
    fireEvent.click(viewer.querySelector('img')!);
    expect(screen.getByText('1 из 2')).toBeInTheDocument();
    fireEvent.click(viewer);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('больше четырёх — в три колонки', () => {
    const { container } = render(<PostGallery items={['1', '2', '3', '4', '5'].map((n) => shot(`${n}.png`))} />);
    expect(container.querySelector('.post-gallery')).toHaveClass('many');
  });
});

describe('композер: несколько файлов', () => {
  const pick = (files: File[]) =>
    fireEvent.change(document.getElementById('composer-file')!, { target: { files } });
  const png = (name: string) => new File(['x'], name, { type: 'image/png' });

  it('два снимка — галерея с «Убрать» у каждого; уходят одним запросом', async () => {
    const create = vi.spyOn(api, 'createPost').mockResolvedValue({ post: { id: 9 } as Post });
    const onPublished = vi.fn();
    render(<Composer onPublished={onPublished} />);
    pick([png('a.png'), png('b.png')]);
    pick([png('c.png')]);
    expect(screen.getByText(/Галерея: 3 из 10/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Убрать b.png' }));
    expect(screen.getByText(/Галерея: 2 из 10/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }));
    });
    expect(create.mock.calls[0][1]).toEqual([expect.objectContaining({ name: 'a.png' }), expect.objectContaining({ name: 'c.png' })]);
    expect(onPublished).toHaveBeenCalled();
  });

  it('аудио к снимкам — отказ; больше десяти — лишние не добавлены', () => {
    render(<Composer onPublished={() => undefined} />);
    pick([png('a.png'), new File(['x'], 't.mp3', { type: 'audio/mpeg' })]);
    expect(screen.getByText(/Аудио публикуется отдельно/)).toBeInTheDocument();
    pick(Array.from({ length: 12 }, (_, i) => png(`${i}.png`)));
    expect(screen.getByText(/не больше 10 фото и видео/)).toBeInTheDocument();
    expect(screen.getByText(/Галерея: 10 из 10/)).toBeInTheDocument();
  });
});
