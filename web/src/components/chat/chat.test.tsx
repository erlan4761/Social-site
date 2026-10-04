import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type Poll } from '../../api';
import { Composer } from './Composer';
import { MessageText, firstUrl } from './MessageText';
import { PollCard } from './PollCard';
import { PinnedBar } from './PaneParts';
import { PollDialog } from '../PollDialog';
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

describe('разметка в пузыре', () => {
  it('жирный, курсив, код и ссылка внутри жирного', () => {
    const { container } = render(
      <MemoryRouter>
        <div>
          <MessageText text="**Важно:** __завтра__ в `10:00`, **https://example.com**" />
        </div>
      </MemoryRouter>,
    );
    expect(container.querySelector('strong')?.textContent).toBe('Важно:');
    expect(container.querySelector('em')?.textContent).toBe('завтра');
    expect(container.querySelector('code.md-code')?.textContent).toBe('10:00');
    expect(screen.getByRole('link', { name: 'https://example.com' }).closest('strong')).not.toBeNull();
  });

  it('спойлер скрыт от глаз и скринридера, пока его не нажмут', () => {
    render(
      <MemoryRouter>
        <div>
          <MessageText text="Концовка: ||всё было сном||" />
        </div>
      </MemoryRouter>,
    );
    const spoiler = screen.getByRole('button', { name: /Скрытый текст/ });
    expect(spoiler.querySelector('[aria-hidden="true"]')?.textContent).toBe('всё было сном');
    fireEvent.click(spoiler);
    expect(screen.queryByRole('button', { name: /Скрытый текст/ })).toBeNull();
    expect(screen.getByText('всё было сном')).toBeVisible();
  });
});

describe('оформление в поле ввода', () => {
  it('Ctrl+B оборачивает выделение, полоса над полем — тоже', () => {
    render(<Composer placeholder="Сообщение" onSend={async () => true} />);
    const field = screen.getByPlaceholderText('Сообщение') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'скажи привет всем' } });
    field.setSelectionRange(6, 12);
    fireEvent.select(field);
    // Выделено — появилась полоса оформления.
    expect(screen.getByRole('toolbar', { name: /Оформление/ })).toBeInTheDocument();

    fireEvent.keyDown(field, { key: 'и', code: 'KeyB', ctrlKey: true });
    expect(field.value).toBe('скажи **привет** всем');

    // Выделение осталось на слове — уже внутри знаков.
    expect([field.selectionStart, field.selectionEnd]).toEqual([8, 14]);
    fireEvent.click(screen.getByRole('button', { name: 'Спойлер' }));
    expect(field.value).toBe('скажи **||привет||** всем');
  });
});

describe('меню кнопки отправки', () => {
  it('правый щелчок — «без звука» и «позже»; «без звука» отправляет с silent', async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer placeholder="Сообщение" onSend={onSend} silent onSchedule={async () => undefined} />);
    const field = screen.getByPlaceholderText('Сообщение') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Спокойной ночи' } });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Отправить' }));
    expect(screen.getByRole('menuitem', { name: 'Отправить позже' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Отправить без звука' }));
    });
    expect(onSend).toHaveBeenCalledWith('Спокойной ночи', { silent: true });
    expect(screen.queryByRole('menu', { name: 'Как отправить' })).toBeNull();
  });

  it('без «silent» и «позже» меню нет — обычная кнопка', () => {
    render(<Composer placeholder="Сообщение" onSend={async () => true} />);
    fireEvent.change(screen.getByPlaceholderText('Сообщение'), { target: { value: 'Привет' } });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Отправить' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('обычная отправка — без опций', async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer placeholder="Сообщение" onSend={onSend} silent />);
    fireEvent.change(screen.getByPlaceholderText('Сообщение'), { target: { value: 'Громко' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    });
    expect(onSend).toHaveBeenCalledWith('Громко');
  });
});

describe('несколько закреплённых', () => {
  const pins = [
    { id: 30, body: 'Третье', attachmentKind: null },
    { id: 20, body: 'Второе', attachmentKind: null },
    { id: 10, body: 'Первое', attachmentKind: null },
  ];

  it('нажатие ведёт к закреплённому и переходит к предыдущему — по кругу', () => {
    const onOpen = vi.fn();
    render(<PinnedBar pins={pins} onOpen={onOpen} />);
    const bar = screen.getByRole('button', { name: /Закреплённое 1 из 3/ });
    expect(bar).toHaveTextContent('Третье');
    fireEvent.click(bar);
    expect(onOpen).toHaveBeenLastCalledWith(30);
    expect(screen.getByRole('button', { name: /Закреплённое 2 из 3/ })).toHaveTextContent('Второе');
    fireEvent.click(screen.getByRole('button', { name: /2 из 3/ }));
    fireEvent.click(screen.getByRole('button', { name: /3 из 3/ }));
    expect(onOpen.mock.calls.map((c) => c[0])).toEqual([30, 20, 10]);
    expect(screen.getByRole('button', { name: /1 из 3/ })).toBeInTheDocument();
    expect(document.querySelectorAll('.pinned-marks span')).toHaveLength(3);
  });

  it('крестик открепляет то, что на виду; одно — без счёта и рисок', () => {
    const onUnpin = vi.fn();
    const { rerender } = render(<PinnedBar pins={pins} onOpen={() => undefined} onUnpin={onUnpin} />);
    fireEvent.click(screen.getByRole('button', { name: /1 из 3/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Открепить это сообщение' }));
    expect(onUnpin).toHaveBeenCalledWith(20);
    rerender(<PinnedBar pins={[pins[2]]} onOpen={() => undefined} onUnpin={onUnpin} />);
    expect(screen.getByRole('button', { name: /Закреплённое сообщение/ })).toHaveTextContent('Первое');
    expect(document.querySelector('.pinned-marks')).toBeNull();
  });
});

describe('викторина', () => {
  const answered = (mine: number) =>
    poll({
      quiz: true,
      total: 1,
      myVotes: [mine],
      correctOptionId: 12,
      explanation: 'HP5 — классика ч/б.',
      options: [
        { id: 11, text: 'Kodak', votes: mine === 11 ? 1 : 0, voters: [] },
        { id: 12, text: 'Ilford', votes: mine === 12 ? 1 : 0, voters: [] },
      ],
    });

  it('неверный ответ — красным, правильный — зелёным, пояснение; голос не отменить', () => {
    const { container } = render(<PollCard question="Что ч/б?" poll={answered(11)} readOnly={false} onVote={() => undefined} onClose={() => undefined} />);
    expect(screen.getByText('Анонимная викторина')).toBeInTheDocument();
    expect(container.querySelector('.poll-row.wrong')).toHaveTextContent('Kodak');
    expect(container.querySelector('.poll-row.correct')).toHaveTextContent('Ilford');
    expect(screen.getByRole('status')).toHaveTextContent('Неверно');
    expect(screen.getByText('HP5 — классика ч/б.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отменить голос' })).toBeNull();
  });

  it('верный ответ — «Верно!»', () => {
    render(<PollCard question="Что ч/б?" poll={answered(12)} readOnly={false} onVote={() => undefined} onClose={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('Верно!');
    expect(screen.getByText('правильный ответ', { exact: false })).toBeInTheDocument();
  });

  it('до ответа — обычные кнопки, без подсказки', () => {
    const { container } = render(
      <PollCard question="Что ч/б?" poll={poll({ quiz: true, correctOptionId: null })} readOnly={false} onVote={() => undefined} onClose={() => undefined} />,
    );
    expect(screen.getAllByRole('button', { name: /Kodak|Ilford/ })).toHaveLength(2);
    expect(container.querySelector('.poll-row.correct')).toBeNull();
  });
});

describe('окно «Новый опрос» — викторина', () => {
  it('отмеченный правильный уходит номером среди заполненных, с пояснением', async () => {
    const onSubmit = vi.fn(async () => undefined);
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.open = false; };
    render(<PollDialog where="В чате" onSubmit={onSubmit} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Вопрос'), { target: { value: 'Что ч/б?' } });
    fireEvent.change(screen.getByLabelText('Вариант 1'), { target: { value: 'Kodak Gold' } });
    fireEvent.change(screen.getByLabelText('Вариант 2'), { target: { value: 'Ilford HP5' } });
    fireEvent.change(screen.getByLabelText('Вариант 3'), { target: { value: 'Fomapan' } });
    fireEvent.click(screen.getByLabelText(/Викторина/));
    expect(screen.getByRole('heading', { name: 'Новая викторина' })).toBeInTheDocument();
    // Без отметки — подсказка, а не отправка.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Создать викторину' }));
    });
    expect(screen.getByText('Отметьте правильный ответ викторины.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Вариант 2 — правильный ответ'));
    fireEvent.change(screen.getByLabelText(/Пояснение/), { target: { value: 'HP5 — ч/б' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Создать викторину' }));
    });
    expect(onSubmit).toHaveBeenCalledWith({
      question: 'Что ч/б?', options: ['Kodak Gold', 'Ilford HP5', 'Fomapan'], multiple: false, anonymous: true,
      quiz: true, correct: 1, explanation: 'HP5 — ч/б',
    });
  });
});
