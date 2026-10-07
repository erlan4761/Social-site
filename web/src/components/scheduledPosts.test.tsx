import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, type Post } from '../api';
import { Composer } from './Composer';
import { ScheduledPostsBar } from './ScheduledPosts';

vi.mock('../session', () => ({
  useSession: () => ({ user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null } }),
}));

const inHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

describe('отложенные записи', () => {
  it('композер: «Опубликовать позже» — окно, запрос, поле очищено, очередь знает', async () => {
    const schedule = vi.spyOn(api, 'schedulePost').mockResolvedValue({ scheduled: { id: 1, body: 'Анонс', sendAt: inHour(), createdAt: inHour() } });
    const onScheduled = vi.fn();
    render(<Composer onPublished={() => undefined} onScheduled={onScheduled} />);
    const later = screen.getByRole('button', { name: 'Опубликовать позже' });
    expect(later).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Новый пост'), { target: { value: 'Анонс' } });
    fireEvent.click(later);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Через час' }));
    });
    expect(schedule).toHaveBeenCalledWith('Анонс', expect.any(Date));
    expect(onScheduled).toHaveBeenCalled();
    expect(screen.getByLabelText('Новый пост')).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent(/Запись выйдет/);
  });

  it('с файлом отложить нельзя', () => {
    render(<Composer onPublished={() => undefined} onScheduled={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Новый пост'), { target: { value: 'С фото' } });
    fireEvent.change(document.getElementById('composer-file')!, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    const later = screen.getByRole('button', { name: 'Опубликовать позже' });
    expect(later).toBeDisabled();
    expect(later).toHaveAttribute('title', expect.stringMatching(/только текст/));
  });

  it('полоса очереди: «Опубликовать сейчас» отдаёт запись ленте', async () => {
    vi.spyOn(api, 'scheduledPosts').mockResolvedValue({ scheduled: [{ id: 7, body: 'Анонс', sendAt: inHour(), createdAt: inHour() }] });
    const post = { id: 70, body: 'Анонс' } as Post;
    const publish = vi.spyOn(api, 'publishScheduledPost').mockResolvedValue({ post });
    const onPublished = vi.fn();
    render(<ScheduledPostsBar version={0} onPublished={onPublished} onDue={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: /Запланировано: 1 запись/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Опубликовать сейчас' }));
    });
    expect(publish).toHaveBeenCalledWith(7);
    expect(onPublished).toHaveBeenCalledWith(post);
  });
});
