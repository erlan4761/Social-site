import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MessageList, type BubbleItem } from './MessageList';
import { MessageText, internalPath } from './MessageText';

vi.mock('../../session', () => ({ useSession: () => ({ user: { username: 'demo' } }) }));

const item: BubbleItem = {
  id: 7, body: 'Встреча в субботу', createdAt: new Date().toISOString(), mine: false, editedAt: null, forwardedFrom: null,
  replyTo: null, reactions: [], attachment: null, canEdit: false, canDelete: false,
};

function list(link: boolean, onAction = vi.fn()) {
  render(
    <MemoryRouter>
      <MessageList
        items={[item]}
        loading={false}
        hasMore={false}
        loadingMore={false}
        onLoadOlder={() => undefined}
        empty={null}
        onAction={onAction}
        actions={{ link }}
      />
    </MemoryRouter>,
  );
  fireEvent.contextMenu(screen.getByText('Встреча в субботу'));
  return onAction;
}

describe('ссылка на сообщение', () => {
  it('«Копировать ссылку» — там, где её включили (группа, канал)', () => {
    const onAction = list(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Копировать ссылку' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'link' }, expect.objectContaining({ id: 7 }));
  });

  it('в личке пункта нет', () => {
    list(false);
    expect(screen.queryByRole('menuitem', { name: 'Копировать ссылку' })).toBeNull();
  });

  it('ссылка на сам сайт — переход в этой же вкладке, чужой — в новой', () => {
    const own = `${window.location.origin}/messages/c/5?m=7`;
    expect(internalPath(own)).toBe('/messages/c/5?m=7');
    expect(internalPath('https://example.com/messages/c/5')).toBeNull();
    render(
      <MemoryRouter>
        <p>
          <MessageText text={`Вот: ${own} и https://example.com/x`} />
        </p>
      </MemoryRouter>,
    );
    const inside = screen.getByRole('link', { name: own });
    expect(inside).toHaveAttribute('href', '/messages/c/5?m=7');
    expect(inside).not.toHaveAttribute('target');
    expect(screen.getByRole('link', { name: 'https://example.com/x' })).toHaveAttribute('target', '_blank');
  });
});
