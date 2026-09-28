/** Russian plural picker: 1 минута, 2 минуты, 5 минут. */
export function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const withYear = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const exact = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' });

export function timeAgo(iso: string) {
  const then = new Date(iso);
  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);

  if (seconds < 45) return 'только что';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;

  return then.getFullYear() === new Date().getFullYear()
    ? dayMonth.format(then)
    : withYear.format(then);
}

export const fullDate = (iso: string) => exact.format(new Date(iso));

// ─ Мессенджер ───────────────────────────────────────────────────────────────

const clock = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const dayLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });

/** Полночь того же календарного дня — в часовом поясе смотрящего. */
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const DAY_MS = 24 * 60 * 60 * 1000;

/** Сколько календарных дней назад: 0 — сегодня, 1 — вчера. По полуночам, а не
 *  по 24 часам: сообщение в 23:50 уже «вчера» в 00:10. */
function daysBack(iso: string) {
  return Math.round((startOfDay(new Date()).getTime() - startOfDay(new Date(iso)).getTime()) / DAY_MS);
}

/** `14:05` — время внутри пузыря. */
export const clockTime = (iso: string) => clock.format(new Date(iso));

/** Время в списке чатов: сегодня — часы, на этой неделе — день недели, раньше — дата. */
export function listTime(iso: string) {
  const back = daysBack(iso);
  if (back <= 0) return clockTime(iso);
  if (back < 7) return weekday.format(new Date(iso));
  return shortDate.format(new Date(iso));
}

/** Разделитель дней в переписке: «Сегодня», «Вчера», «12 сентября», «12 сентября 2025 г.». */
export function dayLabel(iso: string) {
  const back = daysBack(iso);
  if (back <= 0) return 'Сегодня';
  if (back === 1) return 'Вчера';
  const d = new Date(iso);
  return d.getFullYear() === new Date().getFullYear() ? dayLong.format(d) : withYear.format(d);
}

/** Ключ календарного дня для группировки сообщений под разделителем. */
export const dayKey = (iso: string) => startOfDay(new Date(iso)).getTime();

/**
 * Порог «в сети». Сервер обновляет отметку не чаще раза в минуту, а открытая
 * вкладка опрашивает счётчики раз в полминуты — значит, у того, кто сейчас на
 * сайте, отметке не больше полутора минут. Две — с запасом на задержки.
 */
const ONLINE_MS = 2 * 60_000;

export const isOnline = (lastSeenAt: string | null | undefined) =>
  lastSeenAt != null && Date.now() - Date.parse(lastSeenAt) < ONLINE_MS;

/** Подзаголовок собеседника: «в сети», «был(а) 5 минут назад», «был(а) вчера в 14:05». */
export function lastSeenLabel(lastSeenAt: string | null | undefined) {
  if (lastSeenAt == null) return 'был(а) давно';
  if (isOnline(lastSeenAt)) return 'в сети';

  const minutes = Math.floor((Date.now() - Date.parse(lastSeenAt)) / 60_000);
  if (minutes < 60) return `был(а) ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;

  const back = daysBack(lastSeenAt);
  if (back <= 0) return `был(а) сегодня в ${clockTime(lastSeenAt)}`;
  if (back === 1) return `был(а) вчера в ${clockTime(lastSeenAt)}`;
  return `был(а) ${dayLabel(lastSeenAt)}`;
}
export const joinedOn = (iso: string) => withYear.format(new Date(iso));

// ─ Архив по месяцам ─────────────────────────────────────────────────────────

/**
 * Названия месяцев статичны намеренно. Строка вида `2026-09` разбирается
 * вручную: `new Date('2026-09')` — это полночь UTC, и в отрицательном
 * смещении браузер показал бы август вместо сентября.
 */
const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/** `'2026-09'` → `'Сентябрь 2026'`. Нераспознанное возвращается как есть. */
export function monthLabel(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const index = Number(match[2]) - 1;
  const name = MONTH_NAMES[index];
  return name ? `${name} ${match[1]}` : month;
}

/** `'2026-09'` → `'2026'`. Годом считаются первые четыре символа строки. */
export function yearOf(month: string) {
  return month.slice(0, 4);
}
