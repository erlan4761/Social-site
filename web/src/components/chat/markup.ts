/* ─ Разметка текста ──────────────────────────────────────────────────────
 * Как в Телеграме: **жирный**, __курсив__, ~~зачёркнутый~~, ||спойлер||,
 * `код` и ```блок кода```. Хранится сам текст со знаками — сервер его не
 * разбирает (кроме превью, см. server/src/markup.js, правила там те же), а
 * пузырь рисует по дереву отсюда.
 *
 * Правила:
 * - внутри кода разметки нет: `**` там — просто звёздочки;
 * - знак открывает, если за ним не пробел, и закрывает, если перед ним не
 *   пробел: «2 ** 3» остаётся как есть;
 * - пустое выделение (`****`) и незакрытый знак остаются текстом;
 * - ссылка — целиком, её `__` и `**` разметкой не считаются, а знаки сразу
 *   после неё — это уже разметка: **https://example.com** — жирная ссылка.
 */

export type Mark = 'bold' | 'italic' | 'strike' | 'spoiler';

export type MarkupNode =
  | { t: 'text'; s: string }
  | { t: 'url'; url: string }
  | { t: 'code'; s: string }
  | { t: 'pre'; s: string }
  | { t: Mark; children: MarkupNode[] };

export const MARKS: Record<string, Mark> = { '**': 'bold', __: 'italic', '~~': 'strike', '||': 'spoiler' };

// Адрес — до пробела или кавычки; знаки препинания и разметки в конце — это
// уже фраза: «зайди на https://example.com.» ссылается без точки.
const URL_AT = /https?:\/\/[^\s<>"«»`]+/uy;
const TRAILING = /(?:[.,;:!?…)\]}'»]|\*\*|__|~~|\|\|)+$/u;

/** Адрес, начинающийся ровно в `i`, или null. Скобка в конце остаётся, если она парная. */
function urlAt(text: string, i: number): string | null {
  if (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1])) return null;
  URL_AT.lastIndex = i;
  const m = URL_AT.exec(text);
  if (!m) return null;
  let url = m[0].replace(TRAILING, '');
  const opened = (url.match(/\(/g) ?? []).length;
  const closed = (url.match(/\)/g) ?? []).length;
  if (opened > closed && m[0].slice(url.length).startsWith(')')) url += ')';
  return url.length > 'https://'.length ? url : null;
}

type Token =
  | { k: 'text'; s: string }
  | { k: 'url'; url: string }
  | { k: 'code'; s: string }
  | { k: 'pre'; s: string }
  | { k: 'mark'; mark: Mark; raw: string; open: boolean; close: boolean };

const space = (c: string | undefined) => c === undefined || /\s/u.test(c);

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ k: 'text', s: plain });
    plain = '';
  };

  for (let i = 0; i < text.length; ) {
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      // Перевод строки сразу после открывающих кавычек — оформление, а не текст.
      const body = end > 0 ? text.slice(i + 3, end).replace(/^\n/, '').replace(/\n$/, '') : '';
      if (body) {
        flush();
        out.push({ k: 'pre', s: body });
        i = end + 3;
        continue;
      }
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      const body = end > 0 ? text.slice(i + 1, end) : '';
      if (body && !body.includes('\n')) {
        flush();
        out.push({ k: 'code', s: body });
        i = end + 1;
        continue;
      }
    }
    if (text[i] === 'h') {
      const url = urlAt(text, i);
      if (url) {
        flush();
        out.push({ k: 'url', url });
        i += url.length;
        continue;
      }
    }
    const pair = text.slice(i, i + 2);
    const mark = MARKS[pair];
    if (mark) {
      flush();
      out.push({ k: 'mark', mark, raw: pair, open: !space(text[i + 2]), close: !space(text[i - 1]) });
      i += 2;
      continue;
    }
    plain += text[i];
    i += 1;
  }
  flush();
  return out;
}

type Frame = { mark: Mark | null; raw: string; children: MarkupNode[] };

function pushText(into: MarkupNode[], s: string) {
  if (!s) return;
  const last = into[into.length - 1];
  if (last?.t === 'text') last.s += s;
  else into.push({ t: 'text', s });
}

/** Незакрытый знак — снова текст, а то, что успело в него попасть, — рядом. */
function unwind(frame: Frame, into: MarkupNode[]) {
  pushText(into, frame.raw);
  for (const node of frame.children) {
    if (node.t === 'text') pushText(into, node.s);
    else into.push(node);
  }
}

export function parseMarkup(text: string): MarkupNode[] {
  const root: Frame = { mark: null, raw: '', children: [] };
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1];

  for (const tok of tokenize(text)) {
    if (tok.k === 'text') pushText(top().children, tok.s);
    else if (tok.k === 'url') top().children.push({ t: 'url', url: tok.url });
    else if (tok.k === 'code' || tok.k === 'pre') top().children.push({ t: tok.k, s: tok.s });
    else {
      let at = -1;
      for (let j = stack.length - 1; j > 0; j--) {
        if (stack[j].mark === tok.mark) {
          at = j;
          break;
        }
      }
      if (at > 0 && tok.close && stack[at].children.length > 0) {
        while (stack.length - 1 > at) {
          const inner = stack.pop()!;
          unwind(inner, top().children);
        }
        const done = stack.pop()!;
        top().children.push({ t: done.mark!, children: done.children });
      } else if (tok.open) {
        stack.push({ mark: tok.mark, raw: tok.raw, children: [] });
      } else {
        pushText(top().children, tok.raw);
      }
    }
  }
  while (stack.length > 1) {
    const inner = stack.pop()!;
    unwind(inner, top().children);
  }
  return root.children;
}

/** Спойлер там, где его не раскрыть (превью, цитата), — заглушка, а не текст. */
export const SPOILER_STUB = '▒▒▒';

/**
 * Текст без знаков разметки. `spoilers: 'hide'` — для превью, где спойлер
 * не раскрыть: список чатов, цитата, уведомление; `'show'` — для копирования.
 */
export function plainText(text: string, spoilers: 'hide' | 'show' = 'hide'): string {
  const walk = (nodes: MarkupNode[]): string =>
    nodes
      .map((n) => {
        switch (n.t) {
          case 'text': return n.s;
          case 'url': return n.url;
          case 'code': case 'pre': return n.s;
          case 'spoiler': return spoilers === 'hide' ? SPOILER_STUB : walk(n.children);
          default: return walk(n.children);
        }
      })
      .join('');
  return walk(parseMarkup(text));
}

/** Первая ссылка сообщения вне кода — для карточки предпросмотра, как в Телеграме. */
export function firstUrl(text: string): string | null {
  const find = (nodes: MarkupNode[]): string | null => {
    for (const n of nodes) {
      if (n.t === 'url') return n.url;
      if ('children' in n) {
        // Ссылку под спойлером карточкой не раскрываем.
        if (n.t === 'spoiler') continue;
        const inner = find(n.children);
        if (inner) return inner;
      }
    }
    return null;
  };
  return find(parseMarkup(text));
}

/* ─ Поле ввода ──────────────────────────────────────────────────────────── */

/** Кнопки полосы оформления: знак, название, клавиши, буква на кнопке. */
export const FORMATS: { name: Mark | 'mono'; mark: string; label: string; keys: string; short: string }[] = [
  { name: 'bold', mark: '**', label: 'Жирный', keys: 'Ctrl+B', short: 'Ж' },
  { name: 'italic', mark: '__', label: 'Курсив', keys: 'Ctrl+I', short: 'К' },
  { name: 'strike', mark: '~~', label: 'Зачёркнутый', keys: 'Ctrl+Shift+X', short: 'З' },
  { name: 'mono', mark: '`', label: 'Моноширинный', keys: 'Ctrl+Shift+M', short: '<>' },
  { name: 'spoiler', mark: '||', label: 'Спойлер', keys: 'Ctrl+Shift+P', short: '▒' },
];

/** Горячая клавиша форматирования → знак, как в Телеграме для компьютера. */
export function markForKey(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  // По `code`, а не `key`: в русской раскладке Ctrl+B — это «и».
  const k = (e.code ?? '').replace(/^Key/, '').toLowerCase() || e.key.toLowerCase();
  if (!e.shiftKey && k === 'b') return '**';
  if (!e.shiftKey && k === 'i') return '__';
  if (e.shiftKey && k === 'x') return '~~';
  if (e.shiftKey && k === 'm') return '`';
  if (e.shiftKey && k === 'p') return '||';
  return null;
}

/**
 * Обернуть выделение знаками. Пробелы по краям выделения остаются снаружи —
 * иначе «** слово**» не было бы разметкой. Уже обёрнутое тем же знаком —
 * разворачивается обратно, как повторное Ctrl+B. Без выделения — пара знаков
 * с кареткой посередине. Многострочное выделение моноширинным — блок кода.
 */
export function applyMark(text: string, start: number, end: number, mark: string) {
  let a = start;
  let b = end;
  while (a < b && /\s/u.test(text[a])) a++;
  while (b > a && /\s/u.test(text[b - 1])) b--;
  const m = mark === '`' && text.slice(a, b).includes('\n') ? '```' : mark;

  if (a === b) {
    const next = text.slice(0, start) + m + m + text.slice(end);
    return { text: next, start: start + m.length, end: start + m.length };
  }
  if (text.slice(a - m.length, a) === m && text.slice(b, b + m.length) === m) {
    const next = text.slice(0, a - m.length) + text.slice(a, b) + text.slice(b + m.length);
    return { text: next, start: a - m.length, end: b - m.length };
  }
  const next = text.slice(0, a) + m + text.slice(a, b) + m + text.slice(b);
  return { text: next, start: a + m.length, end: b + m.length };
}
