import { describe, expect, it } from 'vitest';
import type { ChatFolder } from './api';
import { folderUnread, inFolder, toggleInFolder, type FolderRow } from './folders';
import { lastSeenLabel, plural } from './time';
import { mergeLatest, previewText, revealOlder, typingLabel } from './components/chat/format';
import { mentionQuery } from './components/chat/MessageText';

/** Правила интерфейса, которые проще проверить функцией, чем глазами. */

const folder = (patch: Partial<ChatFolder> = {}): ChatFolder => ({
  id: 1, title: 'Тест', types: [], include: [], exclude: [], excludeMuted: false, excludeRead: false, ...patch,
});
const row = (patch: Partial<FolderRow> = {}): FolderRow => ({ kind: 'dm', id: 7, unread: 0, muted: false, ...patch });

describe('папки', () => {
  it('берут чат по виду', () => {
    expect(inFolder(folder({ types: ['dm'] }), row())).toBe(true);
    expect(inFolder(folder({ types: ['chat'] }), row())).toBe(false);
  });

  it('исключение сильнее и вида, и ручного добавления', () => {
    const ref = { kind: 'dm' as const, id: 7 };
    expect(inFolder(folder({ types: ['dm'], include: [ref], exclude: [ref] }), row())).toBe(false);
  });

  it('добавленный вручную не подчиняется флажкам «скрывать»', () => {
    const f = folder({ include: [{ kind: 'dm', id: 7 }], excludeMuted: true, excludeRead: true });
    expect(inFolder(f, row({ muted: true, unread: 0 }))).toBe(true);
  });

  it('флажки скрывают приглушённые и прочитанные среди чатов по виду', () => {
    const f = folder({ types: ['dm'], excludeMuted: true, excludeRead: true });
    expect(inFolder(f, row({ muted: true, unread: 3 }))).toBe(false);
    expect(inFolder(f, row({ unread: 0 }))).toBe(false);
    expect(inFolder(f, row({ unread: 2 }))).toBe(true);
  });

  it('счётчик — чаты с непрочитанным, приглушённые не считаются', () => {
    const f = folder({ types: ['dm'] });
    expect(folderUnread(f, [row({ id: 1, unread: 2 }), row({ id: 2, unread: 5, muted: true }), row({ id: 3 })])).toBe(1);
  });

  it('убрать из папки чат, попавший по виду, — значит исключить его', () => {
    const next = toggleInFolder(folder({ types: ['dm'] }), row(), false);
    expect(next.exclude).toEqual([{ kind: 'dm', id: 7 }]);
    expect(toggleInFolder(folder({ exclude: next.exclude }), row(), true).exclude).toEqual([]);
  });
});

describe('время и слова', () => {
  it('склоняет по-русски', () => {
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, 'голос', 'голоса', 'голосов'))).toEqual([
      'голос', 'голоса', 'голосов', 'голосов', 'голос', 'голоса', 'голосов',
    ]);
  });

  it('скрытое время — «недавно», при блокировке — «давно»', () => {
    expect(lastSeenLabel(null, true)).toBe('был(а) недавно');
    expect(lastSeenLabel(null)).toBe('был(а) давно');
    expect(lastSeenLabel(new Date().toISOString())).toBe('в сети');
  });

  it('«печатает» для группы', () => {
    expect(typingLabel(['Мия'])).toBe('Мия печатает');
    expect(typingLabel(['Мия', 'Лев'])).toBe('Мия и Лев печатают');
    expect(typingLabel(['а', 'б', 'в'])).toBe('3 человека печатают');
  });
});

describe('лента сообщений', () => {
  it('превью: текст в одну строку, иначе стикер или вложение', () => {
    expect(previewText('раз\n  два', null)).toBe('раз два');
    expect(previewText('', null, 'plenka/hi')).toBe('Стикер');
    expect(previewText('', { url: '', kind: 'voice', mime: 'audio/webm', name: null, size: null, duration: 3, wave: null })).toBe('Голосовое сообщение');
  });

  it('свежая страница заменяет окно целиком: правки приходят, удалённые исчезают', () => {
    const prev = [{ id: 1, v: 'a' }, { id: 5, v: 'b' }, { id: 6, v: 'c' }];
    const page = [{ id: 5, v: 'B' }, { id: 7, v: 'd' }];
    expect(mergeLatest(prev, page)).toEqual([{ id: 1, v: 'a' }, { id: 5, v: 'B' }, { id: 7, v: 'd' }]);
    expect(mergeLatest(prev, [])).toEqual([]);
  });

  it('до старого сообщения догружает страницы вверх', async () => {
    const pages: Record<number, { items: { id: number }[]; nextCursor: number | null }> = {
      10: { items: [{ id: 8 }, { id: 9 }], nextCursor: 8 },
      8: { items: [{ id: 6 }, { id: 7 }], nextCursor: null },
    };
    const res = await revealOlder(6, [{ id: 10 }], 10, async (c) => pages[c]);
    expect(res.found).toBe(true);
    expect(res.list.map((m) => m.id)).toEqual([6, 7, 8, 9, 10]);
    expect(res.cursor).toBeNull();
  });
});

describe('упоминания при наборе', () => {
  it('ловит «@» и начало имени, в том числе кириллицей', () => {
    expect(mentionQuery('Привет, @ни', 11)).toEqual({ q: 'ни', start: 8 });
    expect(mentionQuery('@', 1)).toEqual({ q: '', start: 0 });
  });

  it('адрес почты и слово без «@» — не упоминание', () => {
    expect(mentionQuery('pia@mail', 8)).toBeNull();
    expect(mentionQuery('просто текст', 12)).toBeNull();
  });
});
