import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type Poll } from '../../api';
import { Composer } from './Composer';
import { MessageText, firstUrl } from './MessageText';
import { PollCard } from './PollCard';
import { DRAFT_SAVE_MS } from './draft';

/** Поведение деталей переписки — как его видит человек: кнопки, подсказки, ссылки. */

const poll = (patch: Partial<Poll> = {}): Poll => ({
  id: 1, multiple: false, anonymous: true, closed: false, total: 0, myVotes: [], canClose: false,
  options: [
    { id: 11, text: 'Kodak', votes: null, voters: [] },
    { id: 12, text: 'Ilford', votes: null, voters: [] },
  ],
  ...patch,
});

describe('опрос', () => {
  it('до голоса — варианты кнопками, щелчок голосует', () => {
    const onVote = vi.fn();
    render(<PollCard question="Что берём?" poll={poll()} readOnly={false} onVote={onVote} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ilford' }));
    expect(onVote).toHaveBeenCalledWith([12]);
  });

  it('несколько ответов — флажки и «Голосовать» со всеми отмеченными', () => {
    const onVote = vi.fn();
    render(<PollCard question="Когда?" poll={poll({ multiple: true })} readOnly={false} onVote={onVote} onClose={() => undefined} />);
    const vote = screen.getByRole('button', { name: 'Голосовать' });
    expect(vote).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Kodak'));
    fireEvent.click(screen.getByLabelText('Ilford'));
    fireEvent.click(vote);
    expect(onVote).toHaveBeenCalledWith([11, 12]);
  });

  it('после голоса — проценты, свой выбор и «Отменить голос»', () => {
    const onVote = vi.fn();
    const voted = poll({
      total: 2, myVotes: [11],
      options: [
        { id: 11, text: 'Kodak', votes: 1, voters: [] },
        { id: 12, text: 'Ilford', votes: 1, voters: [] },
      ],
    });
    render(<PollCard question="Что берём?" poll={voted} readOnly={false} onVote={onVote} onClose={() => undefined} />);
    expect(screen.getAllByText('50%')).toHaveLength(2);
    expect(screen.getByText(/ваш выбор/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Отменить голос' }));
    expect(onVote).toHaveBeenCalledWith([]);
  });

  it('автор видит итоги по кнопке, но голосует как все', () => {
    const own = poll({ canClose: true, options: poll().options.map((o) => ({ ...o, votes: 0 })) });
    render(<PollCard question="Что берём?" poll={own} readOnly={false} onVote={() => undefined} onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Kodak' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Результаты' }));
    expect(screen.getAllByText('0%')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Завершить опрос' })).toBeInTheDocument();
  });
});

describe('упоминания', () => {
  it('@логин — ссылка на профиль, своё имя выделено', () => {
    render(
      <MemoryRouter>
        <p>
          <MessageText text="@nina и @Demo, встречаемся. Почта a@b.ru" me="demo" />
        </p>
      </MemoryRouter>,
    );
    const nina = screen.getByRole('link', { name: '@nina' });
    expect(nina).toHaveAttribute('href', '/u/nina');
    expect(screen.getByRole('link', { name: '@Demo' })).toHaveClass('mention', 'me');
    expect(screen.queryByRole('link', { name: /b\.ru/ })).toBeNull();
  });

  it('в поле ввода «@ни» подсказывает Нину, Enter вставляет логин', () => {
    render(
      <Composer
        placeholder="Сообщение"
        onSend={async () => true}
        mentionables={[
          { id: 2, username: 'nina', displayName: 'Нина Барто', avatarUrl: null },
          { id: 3, username: 'oleg_k', displayName: 'Олег Кузьмин', avatarUrl: null },
        ]}
      />,
    );
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Привет, @ни', selectionStart: 11, selectionEnd: 11 } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Нина Барто');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.value).toBe('Привет, @nina ');
    expect(screen.queryByRole('option')).toBeNull();
  });
});

describe('черновик', () => {
  it('подставляется при открытии, сохраняется по паузе, после отправки — пуст', async () => {
    vi.useFakeTimers();
    const load = vi.spyOn(api, 'draft').mockResolvedValue({ draft: { body: 'Недописанное', updatedAt: '' } });
    const put = vi.spyOn(api, 'saveDraft').mockResolvedValue({ draft: null });
    const onSend = vi.fn().mockResolvedValue(true);
    try {
      render(<Composer placeholder="Сообщение" onSend={onSend} draft={{ kind: 'dm', target: 'nina' }} />);
      await act(async () => undefined);
      const field = screen.getByPlaceholderText('Сообщение') as HTMLTextAreaElement;
      expect(load).toHaveBeenCalledWith('dm', 'nina');
      expect(field.value).toBe('Недописанное');

      fireEvent.change(field, { target: { value: 'Недописанное, но уже больше' } });
      await act(async () => vi.advanceTimersByTime(DRAFT_SAVE_MS - 100));
      expect(put).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(200));
      expect(put).toHaveBeenLastCalledWith('dm', 'nina', 'Недописанное, но уже больше');

      fireEvent.keyDown(field, { key: 'Enter' });
      await act(async () => undefined);
      expect(onSend).toHaveBeenCalledWith('Недописанное, но уже больше');
      expect(put).toHaveBeenLastCalledWith('dm', 'nina', '');
      expect(field.value).toBe('');
    } finally {
      load.mockRestore();
      put.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('ссылки в тексте', () => {
  it('адрес — ссылка в новой вкладке, без точки в конце; упоминание рядом живо', () => {
    render(
      <MemoryRouter>
        <p>
          <MessageText text="Смотри https://example.com/a?b=1. И @nina (https://ru.wikipedia.org/wiki/Плёнка_(фото))" />
        </p>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'https://example.com/a?b=1' });
    expect(link).toHaveAttribute('href', 'https://example.com/a?b=1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('link', { name: 'https://ru.wikipedia.org/wiki/Плёнка_(фото)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '@nina' })).toHaveAttribute('href', '/u/nina');
  });

  it('первая ссылка — для карточки; javascript: ссылкой не становится', () => {
    expect(firstUrl('раз http://a.example/x, два https://b.example')).toBe('http://a.example/x');
    expect(firstUrl('нет ссылок')).toBeNull();
    render(<MemoryRouter><p><MessageText text="javascript:alert(1)" /></p></MemoryRouter>);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
