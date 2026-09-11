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
