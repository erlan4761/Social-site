import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Forwarding } from '../ForwardDialog';
import { MessageList, type BubbleItem } from './MessageList';
import { SelectionBar, copyLines, forwardGroups, useSelection } from './selection';

// Ленте нужен только свой логин — для подсветки упоминаний.
vi.mock('../../session', () => ({ useSession: () => ({ user: { username: 'demo' } }) }));

const at = (min: number) => new Date(Date.UTC(2026, 8, 30, 12, min)).toISOString();
const photo = (id: number) => ({ url: `/p/${id}.png`, kind: 'image' as const, mime: 'image/png', name: null, size: 10, duration: null, wave: null });
const item = (id: number, extra: Partial<BubbleItem> = {}): BubbleItem => ({
  id, body: `Сообщение ${id}`, createdAt: at(id), mine: false, editedAt: null, forwardedFrom: null, replyTo: null,
  reactions: [], attachment: null, canEdit: false, canDelete: true,
  author: { id: 2, username: 'nina', displayName: 'Нина', avatarUrl: null }, ...extra,
});

function Harness({ items, onForward }: { items: BubbleItem[]; onForward: (f: Forwarding) => void }) {
  const selection = useSelection(items.map((m) => m.id));
  return (
    <MemoryRouter>
      <MessageList
        items={items}
        loading={false}
        hasMore={false}
        loadingMore={false}
        onLoadOlder={() => undefined}
        empty={null}
        onAction={() => undefined}
        selection={selection}
      />
      {selection.active && (
        <SelectionBar selection={selection} items={items} from="chat" who={(m) => m.author?.displayName ?? ''} onForward={onForward} />
      )}
    </MemoryRouter>
  );
}

describe('выбор нескольких сообщений', () => {
  const items = [
    item(1),
    item(2, { body: '', attachment: photo(2), albumId: 'alb' }),
    item(3, { body: '', attachment: photo(3), albumId: 'alb' }),
    item(4),
  ];

  it('«Выбрать» в меню, нажатие отмечает, альбом — целиком; пересылка — группами', () => {
    const onForward = vi.fn();
    render(<Harness items={items} onForward={onForward} />);
    fireEvent.contextMenu(screen.getByText('Сообщение 1'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Выбрать' }));
    expect(screen.getByText('Выбрано: 1 сообщение')).toBeInTheDocument();

    // Нажатие на альбом отмечает оба снимка.
    fireEvent.click(document.querySelector('.album')!);
    expect(screen.getByText('Выбрано: 3 сообщения')).toBeInTheDocument();

    // Флажок — обычный, с клавиатуры тоже.
    fireEvent.click(screen.getByRole('checkbox', { name: /Сообщение 4/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Сообщение 1/ }));
    expect(screen.getByText('Выбрано: 3 сообщения')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Переслать' }));
    expect(onForward).toHaveBeenCalledWith({
      groups: [[{ from: 'chat', id: 2 }, { from: 'chat', id: 3 }], [{ from: 'chat', id: 4 }]],
      preview: '3 сообщения',
    });
    // После пересылки выбор снят — снова обычная лента.
    expect(screen.queryByRole('toolbar', { name: 'Выбранные сообщения' })).toBeNull();
  });

  it('Esc снимает выбор; в режиме выбора меню не открывается', () => {
    render(<Harness items={items} onForward={() => undefined} />);
    fireEvent.contextMenu(screen.getByText('Сообщение 4'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Выбрать' }));
    fireEvent.contextMenu(screen.getByText('Сообщение 1'));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('toolbar', { name: 'Выбранные сообщения' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('выбранное: группы и буфер обмена', () => {
  it('подряд идущие снимки одного альбома — одна группа', () => {
    expect(forwardGroups('dm', [{ id: 1 }, { id: 2, albumId: 'a' }, { id: 3, albumId: 'a' }, { id: 4, albumId: 'b' }])).toEqual([
      [{ from: 'dm', id: 1 }],
      [{ from: 'dm', id: 2 }, { from: 'dm', id: 3 }],
      [{ from: 'dm', id: 4 }],
    ]);
  });

  it('одно — просто текст; несколько — с именем и датой, без знаков разметки', () => {
    expect(copyLines([item(1, { body: '**Итог** ||тайна||' })], () => 'Нина')).toBe('Итог тайна');
    const text = copyLines([item(1), item(2, { body: '', attachment: photo(2) })], (m) => (m.id === 1 ? 'Нина' : 'Я'));
    expect(text).toMatch(/^Нина, \[30\.09\.2026, \d\d:01\]\nСообщение 1\n\nЯ, \[30\.09\.2026, \d\d:02\]\nФото$/);
  });
});
