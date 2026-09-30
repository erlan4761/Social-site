import { type Attachment, type CallRecord } from '../../api';

/** Чистые помощники мессенджера: подписи, размеры, окно правки, слияние страниц. */

/** Подпись вложения там, где его самого не видно: список чатов, полоса ответа. */
export function attachmentLabel(a: Pick<Attachment, 'kind' | 'name'> | null | undefined) {
  if (!a) return '';
  switch (a.kind) {
    case 'image': return 'Фото';
    case 'video': return 'Видео';
    case 'voice': return 'Голосовое сообщение';
    case 'videonote': return 'Видеосообщение';
    case 'audio': return a.name || 'Аудио';
    case 'file': return a.name || 'Файл';
  }
}

/**
 * Запись о звонке глазами смотрящего: «Исходящий звонок · 2:31»,
 * «Пропущенный видеозвонок», «Звонок отклонён». `mine` — звонил сам.
 */
export function callText(call: CallRecord, mine: boolean) {
  const kind = call.video ? 'видеозвонок' : 'звонок';
  if (call.outcome === 'missed') return mine ? `${cap(kind)} — нет ответа` : `Пропущенный ${kind}`;
  if (call.outcome === 'declined') return mine ? `${cap(kind)} отклонён` : `Отклонённый ${kind}`;
  const s = call.duration ?? 0;
  return `${mine ? 'Исходящий' : 'Входящий'} ${kind} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Превью сообщения в одну строку: текст, а без него — стикер или что приложено. */
export const previewText = (body: string, a: Attachment | null, sticker?: string | null) =>
  body ? oneLine(body) : sticker ? 'Стикер' : attachmentLabel(a);

/** `1536` → `1,5 КБ`. */
export function fileSize(bytes: number | null) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

/** Подпись для группы: «Мия печатает», «Мия и Лев печатают», «3 человека печатают». */
export function typingLabel(names: string[]) {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} печатает`;
  if (names.length === 2) return `${names[0]} и ${names[1]} печатают`;
  return `${names.length} человека печатают`;
}

/**
 * Свежая страница опроса поверх уже загруженного. Страница — последние N
 * сообщений подряд, поэтому всё, что в состоянии не старше её первого id,
 * заменяется ею целиком: так приходят не только новые сообщения, но и правки,
 * реакции, галочки, а удалённые — исчезают. Что старше окна, остаётся как было
 * до следующего открытия переписки: правка сообщения недельной давности не
 * стоит того, чтобы опрашивать всю историю.
 */
export function mergeLatest<T extends { id: number }>(prev: T[], page: T[]): T[] {
  // Пустая страница — в переписке не осталось ни одного сообщения.
  if (page.length === 0) return [];
  const first = page[0].id;
  return [...prev.filter((m) => m.id < first), ...page];
}

/**
 * Показать сообщение, которого может не быть в ленте: догружает страницы
 * вверх, пока не найдёт, и возвращает новую ленту и курсор. Общая для ЛС,
 * групп и каналов — различается только то, как грузить страницу.
 */
export async function revealOlder<T extends { id: number }>(
  id: number,
  list: T[],
  cursor: number | null,
  loadPage: (cursor: number) => Promise<{ items: T[]; nextCursor: number | null }>,
): Promise<{ list: T[]; cursor: number | null; found: boolean }> {
  let items = list;
  let next = cursor;
  // Потолок в двадцать страниц — не повод висеть бесконечно на удалённом.
  for (let i = 0; i < 20 && !items.some((m) => m.id === id) && next != null; i += 1) {
    const page = await loadPage(next);
    items = [...page.items, ...items];
    next = page.nextCursor;
  }
  return { list: items, cursor: next, found: items.some((m) => m.id === id) };
}

/** Переводит «текст сообщения» в строку для полосы ответа: одна строка, без переносов. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Можно ли ещё править — те же 48 часов, что проверяет сервер. */
export const EDIT_WINDOW_MS = 48 * 60 * 60_000;
export const editable = (createdAt: string) => Date.now() - Date.parse(createdAt) < EDIT_WINDOW_MS;
