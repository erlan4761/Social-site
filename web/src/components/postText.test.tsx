import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { PostText } from './PostText';

vi.mock('../session', () => ({ useSession: () => ({ user: { id: 1, username: 'demo' } }) }));

const show = (text: string) =>
  render(
    <MemoryRouter>
      <p>
        <PostText text={text} />
      </p>
    </MemoryRouter>,
  );

describe('текст записи', () => {
  it('@логин — ссылка на профиль, своё — с подсветкой; почта — не упоминание', () => {
    show('Проявляли с @Nina и @demo. Пишите на a@b.ru');
    expect(screen.getByRole('link', { name: '@Nina' })).toHaveAttribute('href', '/u/nina');
    expect(screen.getByRole('link', { name: '@demo' })).toHaveClass('mention', 'me');
    expect(screen.queryByRole('link', { name: /b\.ru/ })).toBeNull();
  });

  it('адрес — ссылка без точки в конце; звёздочки — просто текст', () => {
    const { container } = show('См. https://example.com/x. **не жирный**');
    expect(screen.getByRole('link', { name: 'https://example.com/x' })).toHaveAttribute('target', '_blank');
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('**не жирный**');
  });
});
