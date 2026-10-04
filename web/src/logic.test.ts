import { describe, expect, it } from 'vitest';
import type { ChatFolder } from './api';
import { folderUnread, inFolder, inUnread, readActiveFolder, toggleInFolder, unreadChats, writeActiveFolder, type FolderRow } from './folders';
import { lastSeenLabel, plural } from './time';
import { callText, mergeLatest, previewText, revealOlder, typingLabel } from './components/chat/format';
import { groupAlbums, type BubbleItem } from './components/chat/MessageList';
import { forwardingOf } from './components/ForwardDialog';
import { mentionQuery } from './components/chat/MessageText';
import { dialOf, formatPhone, looksLikePhone, toE164 } from './phone';
import { toPhones } from './contacts';
import { deviceName } from './device';

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

describe('номер телефона', () => {
  it('собирает E.164 из кода страны и набранного', () => {
    expect(toE164('+996', '555 12-34-56')).toBe('+996555123456');
    expect(toE164('+996', '0555 123 456')).toBe('+996555123456');
    expect(toE164('+996', '+7 916 123-45-67')).toBe('+79161234567');
    expect(toE164('+7', '00996555123456')).toBe('+996555123456');
  });

  it('показывает номер по-человечески', () => {
    expect(formatPhone('+996555123456')).toBe('+996 555 12 34 56');
    expect(formatPhone('+79161234567')).toBe('+7 916 123-45-67');
    expect(formatPhone('+4915112345678')).toBe('+49 151 123 456 78');
  });
});

describe('устройство сеанса', () => {
  it('браузер и система из User-Agent', () => {
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36')).toBe('Chrome, Windows');
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari, iPhone');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('Edge, Windows');
  });

  it('непонятное — «Неизвестное устройство»', () => {
    expect(deviceName(null)).toBe('Неизвестное устройство');
    expect(deviceName('curl/8.0')).toBe('Неизвестное устройство');
  });
});

describe('номер в поиске и из контактов', () => {
  it('поиск по номеру — только с «+» и восемью цифрами', () => {
    expect(looksLikePhone('+996 555 12-34-56')).toBe(true);
    expect(looksLikePhone('+7 (916) 123-45-67')).toBe(true);
    expect(looksLikePhone('2024')).toBe(false);
    expect(looksLikePhone('555123456')).toBe(false);
    expect(looksLikePhone('+996 плёнка')).toBe(false);
  });

  it('код страны — по своему номеру', () => {
    expect(dialOf('+996555000001')).toBe('+996');
    expect(dialOf('+79161234567')).toBe('+7');
    expect(dialOf(null)).toBe('+996');
  });

  it('контакты: местные номера дополняются кодом, повторы и обрывки отбрасываются', () => {
    expect(toPhones(['0555 12 34 56', '+996555123456', '+7 916 123-45-67', '103'], '+996')).toEqual([
      '+996555123456',
      '+79161234567',
    ]);
    expect(toPhones(['8 (916) 123-45-67'], '+7')).toEqual(['+79161234567']);
  });
});

describe('альбомы в ленте', () => {
  const item = (id: number, patch: Partial<BubbleItem> = {}): BubbleItem => ({
    id, body: '', createdAt: `2026-09-01T10:00:0${id}Z`, mine: true, editedAt: null, forwardedFrom: null, replyTo: null,
    reactions: [], attachment: { url: `/a/${id}`, kind: 'image', mime: 'image/png', name: null, size: null, duration: null, wave: null },
    canEdit: false, canDelete: true, ...patch,
  });

  it('подряд идущие снимки одного альбома — один пузырь от имени снимка с подписью', () => {
    const out = groupAlbums([item(1, { albumId: 'x' }), item(2, { albumId: 'x', body: 'Подпись' }), item(3, { albumId: 'x' }), item(4)]);
    expect(out.map((m) => m.id)).toEqual([2, 4]);
    expect(out[0].album?.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(out[0].createdAt).toBe(item(3).createdAt);
    expect(out[0].attachment).toBeNull();
  });

  it('одиночный снимок с кодом и разные альбомы подряд не склеиваются', () => {
    expect(groupAlbums([item(1, { albumId: 'x' }), item(2, { albumId: 'y' })]).map((m) => m.album)).toEqual([undefined, undefined]);
  });

  it('удалить альбом можно, только если можно удалить каждый снимок', () => {
    const [one] = groupAlbums([item(1, { albumId: 'x' }), item(2, { albumId: 'x', canDelete: false })]);
    expect(one.canDelete).toBe(false);
  });

  it('пересылается альбом целиком, по порядку; одиночное — одно', () => {
    const [album] = groupAlbums([item(1, { albumId: 'x' }), item(2, { albumId: 'x', body: 'Подпись' }), item(3, { albumId: 'x' })]);
    const f = forwardingOf('channel', album, 'Подпись');
    expect(f.groups).toEqual([[1, 2, 3].map((id) => ({ from: 'channel', id }))]);
    expect(f.preview).toBe('Альбом: 3 снимка — Подпись');
    expect(forwardingOf('dm', item(7), 'Фото')).toEqual({ groups: [[{ from: 'dm', id: 7 }]], preview: 'Фото' });
  });
});

describe('записи о звонках', () => {
  it('каждая сторона видит звонок со своей стороны', () => {
    const ended = { video: false, outcome: 'ended' as const, duration: 151 };
    expect(callText(ended, true)).toBe('Исходящий звонок · 2:31');
    expect(callText(ended, false)).toBe('Входящий звонок · 2:31');
    const missed = { video: true, outcome: 'missed' as const, duration: null };
    expect(callText(missed, true)).toBe('Видеозвонок — нет ответа');
    expect(callText(missed, false)).toBe('Пропущенный видеозвонок');
    expect(callText({ video: false, outcome: 'declined', duration: null }, false)).toBe('Отклонённый звонок');
  });
});


describe('вкладка «Непрочитанные»', () => {
  const r = (unread: number, muted = false): FolderRow => ({ kind: 'dm', id: unread * 10 + (muted ? 1 : 0), unread, muted });

  it('попадают чаты с непрочитанным, и приглушённые тоже; открытый — остаётся', () => {
    expect(inUnread(r(2))).toBe(true);
    expect(inUnread(r(3, true))).toBe(true);
    expect(inUnread(r(0))).toBe(false);
    expect(inUnread(r(0), true)).toBe(true);
  });

  it('счётчик — чатов, без приглушённых', () => {
    expect(unreadChats([r(2), r(5), r(1, true), r(0)])).toBe(2);
  });

  it('вкладка запоминается', () => {
    writeActiveFolder('unread');
    expect(readActiveFolder()).toBe('unread');
    writeActiveFolder(7);
    expect(readActiveFolder()).toBe(7);
    writeActiveFolder(null);
    expect(readActiveFolder()).toBeNull();
  });
});
