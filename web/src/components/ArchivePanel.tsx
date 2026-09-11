import { useState } from 'react';
import type { ArchiveMonth } from '../api';
import { monthLabel, plural, yearOf } from '../time';

type YearGroup = { year: string; count: number; months: ArchiveMonth[] };

/**
 * Месяцы приходят с сервера новыми сверху, но порядок здесь задаётся ещё раз:
 * группировка склеивает только соседей, и один переставленный месяц породил бы
 * два раздела с одним и тем же годом.
 */
export function groupByYear(months: ArchiveMonth[]): YearGroup[] {
  const sorted = [...months].sort((a, b) => b.month.localeCompare(a.month));
  const years: YearGroup[] = [];

  for (const entry of sorted) {
    const year = yearOf(entry.month);
    const last = years.at(-1);
    if (last && last.year === year) {
      last.months.push(entry);
      last.count += entry.count;
    } else {
      years.push({ year, count: entry.count, months: [entry] });
    }
  }

  return years;
}

/** `'2026-09'` → `'Сентябрь'`: в строке года название года уже стоит слева. */
const shortMonth = (month: string) => monthLabel(month).replace(` ${yearOf(month)}`, '');

type Props = {
  months: ArchiveMonth[];
  total: number;
  /** Выбранный период (`YYYY` или `YYYY-MM`), пустая строка — показана вся лента. */
  active: string;
  onPick: (period: string | null) => void;
};

/**
 * Архив профиля: годы, внутри года месяцы с числом записей.
 *
 * Панель свёрнута по умолчанию и раскрывается на месте — как список
 * заблокированных рядом. Отдельной страницы у архива нет намеренно: он нужен
 * ровно там, где лежит лента, которую он фильтрует.
 */
export function ArchivePanel({ months, total, active, onPick }: Props) {
  // Пришли по ссылке с `?period=` — панель обязана быть открыта: иначе не видно,
  // откуда взялся фильтр над лентой.
  const [open, setOpen] = useState(active !== '');
  const years = groupByYear(months);

  return (
    <section className="archive" aria-labelledby="archive-toggle">
      <button
        className={open ? 'act open' : 'act'}
        id="archive-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Архив — {total} {plural(total, 'запись', 'записи', 'записей')}
      </button>

      {open && (
        <div className="archive-body">
          {years.map((group) => (
            <div className="archive-year" key={group.year}>
              <button
                className="archive-tag"
                type="button"
                aria-pressed={active === group.year}
                onClick={() => onPick(active === group.year ? null : group.year)}
              >
                {group.year}
                <span className="sr-only">
                  {' '}
                  год, {group.count} {plural(group.count, 'запись', 'записи', 'записей')}
                </span>
              </button>

              <ul className="archive-months">
                {group.months.map((entry) => (
                  <li key={entry.month}>
                    <button
                      className="archive-tag"
                      type="button"
                      aria-pressed={active === entry.month}
                      onClick={() => onPick(active === entry.month ? null : entry.month)}
                    >
                      {shortMonth(entry.month)}
                      <span className="archive-count" aria-hidden="true">
                        {entry.count}
                      </span>
                      <span className="sr-only">
                        {' '}
                        {group.year}, {entry.count} {plural(entry.count, 'запись', 'записи', 'записей')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
