import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/* ─ Упоминания ───────────────────────────────────────────────────────── */

// То же правило, что в mentions.js на сервере: перед «@» — не буква и не
// цифра, так что адрес почты упоминанием не становится.
const MENTION_RE = /(^|[^\p{L}\p{N}_@])@([a-z0-9_]{3,20})(?![a-z0-9_])/giu;

/** Текст сообщения, где `@логин` — ссылка на профиль; своё имя — с подсветкой. */
export function MessageText({ text, me }: { text: string; me?: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index + match[1].length;
    const name = match[2];
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <Link
        key={start}
        className={name.toLowerCase() === me ? 'mention me' : 'mention'}
        to={`/u/${name.toLowerCase()}`}
      >
        @{name}
      </Link>,
    );
    last = start + 1 + name.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export const fold = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');

/** Что набрано после «@» прямо перед кареткой — или null, если не упоминание. */
export function mentionQuery(text: string, caret: number) {
  // После «@» — и кириллица: «@ни» находит Нину по имени, а вставится её логин.
  const match = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_]{0,20})$/u.exec(text.slice(0, caret));
  return match ? { q: fold(match[2]), start: caret - match[2].length - 1 } : null;
}
