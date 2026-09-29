import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/* ─ Упоминания ───────────────────────────────────────────────────────── */

// То же правило, что в mentions.js на сервере: перед «@» — не буква и не
// цифра, так что адрес почты упоминанием не становится.
const MENTION_RE = /(^|[^\p{L}\p{N}_@])@([a-z0-9_]{3,20})(?![a-z0-9_])/giu;

/* ─ Ссылки ──────────────────────────────────────────────────────────── */

// Адрес — до пробела или кавычки; знаки препинания в конце — это уже фраза:
// «зайди на https://example.com.» ссылается без точки.
const URL_RE = /\bhttps?:\/\/[^\s<>"«»]+/giu;
const TRAILING = /[.,;:!?…)\]}'»]+$/u;

/** Ссылки в тексте: [начало, адрес]. Скобка в конце остаётся, если она парная. */
function urlsIn(text: string) {
  const found: { start: number; url: string }[] = [];
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0].replace(TRAILING, '');
    const opened = (url.match(/\(/g) ?? []).length;
    const closed = (url.match(/\)/g) ?? []).length;
    if (opened > closed && match[0].slice(url.length).startsWith(')')) url += ')';
    if (url.length > 'https://'.length) found.push({ start: match.index, url });
  }
  return found;
}

/** Первая ссылка сообщения — для карточки предпросмотра, как в Телеграме. */
export function firstUrl(text: string) {
  return urlsIn(text)[0]?.url ?? null;
}

/** Упоминания в куске текста без ссылок. */
function withMentions(text: string, offset: number, me: string | undefined, out: ReactNode[]) {
  let last = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index + match[1].length;
    const name = match[2];
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <Link
        key={offset + start}
        className={name.toLowerCase() === me ? 'mention me' : 'mention'}
        to={`/u/${name.toLowerCase()}`}
      >
        @{name}
      </Link>,
    );
    last = start + 1 + name.length;
  }
  if (last < text.length) out.push(text.slice(last));
}

/**
 * Текст сообщения: `@логин` — ссылка на профиль (своё имя — с подсветкой),
 * адреса http(s) — ссылки в новой вкладке. Чужой сайт не узнаёт, откуда
 * пришли (noreferrer), и не получает доступа к нашей вкладке (noopener).
 */
export function MessageText({ text, me }: { text: string; me?: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const { start, url } of urlsIn(text)) {
    if (start > last) withMentions(text.slice(last, start), last, me, out);
    out.push(
      <a key={`u${start}`} className="text-link" href={url} target="_blank" rel="noopener noreferrer nofollow">
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) withMentions(text.slice(last), last, me, out);
  return <>{out}</>;
}

export const fold = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');

/** Что набрано после «@» прямо перед кареткой — или null, если не упоминание. */
export function mentionQuery(text: string, caret: number) {
  // После «@» — и кириллица: «@ни» находит Нину по имени, а вставится её логин.
  const match = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_]{0,20})$/u.exec(text.slice(0, caret));
  return match ? { q: fold(match[2]), start: caret - match[2].length - 1 } : null;
}
