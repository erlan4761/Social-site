/**
 * Тема оформления: светлая, тёмная или как в системе.
 *
 * Как это устроено целиком, в трёх местах:
 *
 *  1. `index.html` — крошечный синхронный скрипт в <head> ставит
 *     `data-theme` на <html> ДО первой отрисовки. Без него страница
 *     успевает моргнуть светлым, прежде чем React смонтируется.
 *  2. `styles/tokens.css` — два пути к тёмным токенам:
 *     `html[data-theme="dark"]` (ручной выбор) и
 *     `@media (prefers-color-scheme: dark) { html:not([data-theme]) }`
 *     (системная тема, пока выбора не сделано). Поэтому в режиме `auto`
 *     атрибут нужно именно СНИМАТЬ, а не выставлять в «light».
 *  3. этот файл — чтение и запись выбора, применение и подписка.
 *
 * Память — `localStorage` браузера, а не сервер: выбор оформления личный,
 * API для него нет и не нужно.
 */

export type ThemeChoice = 'light' | 'dark' | 'auto';

/** Ключ в localStorage. Повторён в inline-скрипте index.html — при
 *  переименовании править оба места. */
export const THEME_KEY = 'chronicle-theme';

export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'auto'];

/** Подписи для переключателя; порядок тот же, что в THEME_CHOICES. */
export const THEME_LABELS: Record<ThemeChoice, string> = {
  light: 'Светлая',
  dark: 'Тёмная',
  auto: 'Как в системе',
};

function isChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'auto';
}

/** Что выбрано человеком. Ничего не выбрано или хранилище недоступно —
 *  считаем, что «как в системе». */
export function readTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return isChoice(saved) ? saved : 'auto';
  } catch {
    // Приватный режим и запрет на хранилище — не повод падать.
    return 'auto';
  }
}

/** Система просит тёмное оформление? */
export function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Какая тема видна на экране прямо сейчас — с учётом системы. */
export function resolveTheme(choice: ThemeChoice = readTheme()): 'light' | 'dark' {
  if (choice === 'auto') return systemPrefersDark() ? 'dark' : 'light';
  return choice;
}

/** Применить выбор к документу. В режиме `auto` атрибут снимается, и тему
 *  дальше решает медиазапрос в tokens.css. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

/** Запомнить выбор и применить его. */
export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Не сохранилось — тема всё равно применится до перезагрузки.
  }
  applyTheme(choice);
}

/**
 * Привести документ в соответствие с сохранённым выбором и вернуть
 * функцию отписки. Вызывается один раз при старте (main.tsx).
 *
 * Подписка на системную тему нужна, чтобы в режиме `auto` оформление
 * менялось сразу, без перезагрузки; `onChange` позволяет переключателю
 * в шапке (FE-02) перерисовать своё активное положение.
 */
export function initTheme(onChange?: (resolved: 'light' | 'dark') => void): () => void {
  applyTheme(readTheme());

  if (typeof matchMedia !== 'function') return () => {};

  const media = matchMedia('(prefers-color-scheme: dark)');
  const listener = () => {
    if (readTheme() === 'auto') onChange?.(systemPrefersDark() ? 'dark' : 'light');
  };

  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
