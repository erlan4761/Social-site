import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type Comment } from '../api';
import { CommentThread, threadsOf } from './CommentThread';

vi.mock('../session', () => ({
  useSession: () => ({ user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null } }),
}));

const who = (id: number, name: string) => ({ id, username: `u${id}`, displayName: name, avatarUrl: null });
const c = (id: number, author: ReturnType<typeof who>, replyTo: Comment | null = null): Comment => ({
  id, postId: 9, body: `Комментарий ${id}`, createdAt: new Date(Date.UTC(2026, 9, 1, 12, id)).toISOString(), author,
  replyTo: replyTo ? { id: replyTo.id, author: { username: replyTo.author.username, displayName: replyTo.author.displayName } } : null,
});

const nina = who(2, 'Нина');
const oleg = who(3, 'Олег');

describe('ветки комментариев', () => {
  it('ответы и ответы на ответы — под корнем, по порядку', () => {
    const root = c(1, nina);
    const r1 = c(2, oleg, root);
    const other = c(3, oleg);
    const r2 = c(4, nina, r1);
    expect(threadsOf([r2, other, r1, root]).map((t) => [t.root.id, t.replies.map((x) => x.id)])).toEqual([
      [1, [2, 4]],
      [3, []],
    ]);
  });

  it('исходный не загружен (удалён, скрыт) — ответ сам становится корнем', () => {
    const lost = c(1, nina);
    expect(threadsOf([c(2, oleg, lost)]).map((t) => t.root.id)).toEqual([2]);
  });

  it('«Ответить» — полоса «Отвечаете: Нина», ответ уходит с replyTo; у ответа на ответ — «в ответ: Олег»', async () => {
    const root = c(1, nina);
    const reply = c(2, oleg, root);
    const deep = c(3, nina, reply);
    vi.spyOn(api, 'comments').mockResolvedValue({ comments: [root, reply, deep] });
    const add = vi.spyOn(api, 'addComment').mockImplementation(async (_post, text, replyTo) => ({
      comment: { ...c(4, who(1, 'Ерлан'), replyTo === 1 ? root : null), body: text },
    }));
    render(
      <MemoryRouter>
        <CommentThread postId={9} postAuthorId={1} onCountChange={() => undefined} />
      </MemoryRouter>,
    );
    await screen.findByText('Комментарий 1');
    // Ответ корню — без подписи, ответ на ответ — «в ответ: Олег».
    expect(screen.getAllByText(/^в ответ: /)).toHaveLength(1);
    expect(screen.getByText('в ответ: Олег')).toBeInTheDocument();
    expect(document.querySelectorAll('.comment-replies .comment')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Ответить' })[0]);
    expect(screen.getByText('Нина', { selector: '.comment-replying strong' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Ваш ответ…'), { target: { value: 'Согласен' } });
    await act(async () => {
      fireEvent.submit(screen.getByPlaceholderText('Ваш ответ…').closest('form')!);
    });
    expect(add).toHaveBeenCalledWith(9, 'Согласен', 1);
    // Ответ встал в ветку Нины, полоса ответа ушла.
    expect(document.querySelectorAll('.comment-replies .comment')).toHaveLength(3);
    expect(document.querySelector('.comment-replying')).toBeNull();
  });
});
