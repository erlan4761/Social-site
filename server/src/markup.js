/**
 * Разметка текста сообщений — **жирный**, __курсив__, ~~зачёркнутый~~,
 * ||спойлер||, `код` и ```блок кода```, как в Телеграме. В базе лежит сам
 * текст со знаками, рисует его клиент (web/src/components/chat/markup.ts —
 * правила там те же). Серверу разметка нужна только там, где текст идёт без
 * пузыря: цитата в ответе, закреплённое, найденное, пуш. Там знаки снимаются,
 * а спойлер заменяется заглушкой: на экране блокировки его не раскрыть, и
 * показывать его содержимое там было бы как раз тем, от чего он защищает.
 */

const MARKS = { '**': 'bold', __: 'italic', '~~': 'strike', '||': 'spoiler' };
const URL_AT = /https?:\/\/[^\s<>"«»`]+/uy;
const TRAILING = /(?:[.,;:!?…)\]}'»]|\*\*|__|~~|\|\|)+$/u;

export const SPOILER_STUB = '▒▒▒';

function urlAt(text, i) {
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

const space = (c) => c === undefined || /\s/u.test(c);

function tokenize(text) {
  const out = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ k: 'text', s: plain });
    plain = '';
  };
  for (let i = 0; i < text.length; ) {
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      const body = end > 0 ? text.slice(i + 3, end).replace(/^\n/, '').replace(/\n$/, '') : '';
      if (body) {
        flush();
        out.push({ k: 'code', s: body });
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
        out.push({ k: 'text', s: url });
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

/** Дерево: строки и `{mark, children}` — ровно столько, сколько нужно для снятия знаков. */
function parse(text) {
  const root = { mark: null, raw: '', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const unwind = (frame, into) => {
    into.push(frame.raw, ...frame.children);
  };
  for (const tok of tokenize(text)) {
    if (tok.k !== 'mark') {
      top().children.push(tok.s);
      continue;
    }
    let at = -1;
    for (let j = stack.length - 1; j > 0; j--) {
      if (stack[j].mark === tok.mark) {
        at = j;
        break;
      }
    }
    if (at > 0 && tok.close && stack[at].children.length > 0) {
      while (stack.length - 1 > at) unwind(stack.pop(), top().children);
      const done = stack.pop();
      top().children.push({ mark: done.mark, children: done.children });
    } else if (tok.open) {
      stack.push({ mark: tok.mark, raw: tok.raw, children: [] });
    } else {
      top().children.push(tok.raw);
    }
  }
  while (stack.length > 1) unwind(stack.pop(), top().children);
  return root.children;
}

/** Текст без знаков разметки; спойлер — заглушкой. */
export function plainText(text) {
  const walk = (nodes) =>
    nodes.map((n) => (typeof n === 'string' ? n : n.mark === 'spoiler' ? SPOILER_STUB : walk(n.children))).join('');
  return walk(parse(String(text ?? '')));
}
