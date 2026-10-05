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

describe('хэштеги в тексте', () => {
  it('#тег в записи — ссылка на ленту тега; «#1», a#b и якорь — нет', () => {
    render(
      <MemoryRouter>
        <p>
          <PostText text="Проявил #Плёнка и #ночь_2, но не #1, a#b и https://x.ru/#якорь" hashtags />
        </p>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '#Плёнка' })).toHaveAttribute('href', `/tag/${encodeURIComponent('пленка')}`);
    expect(screen.getByRole('link', { name: '#ночь_2' })).toHaveClass('tag-link');
    expect(screen.queryByRole('link', { name: '#1' })).toBeNull();
    expect(screen.queryByRole('link', { name: '#b' })).toBeNull();
    expect(screen.getByRole('link', { name: 'https://x.ru/#якорь' })).toBeInTheDocument();
  });

  it('без hashtags (комментарии) — теги просто текст', () => {
    const { container } = show('Смотрите #плёнка и @nina');
    expect(screen.queryByRole('link', { name: '#плёнка' })).toBeNull();
    expect(screen.getByRole('link', { name: '@nina' })).toBeInTheDocument();
    expect(container.textContent).toBe('Смотрите #плёнка и @nina');
  });
});
