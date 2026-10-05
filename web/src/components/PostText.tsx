import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session';
import { internalPath } from './chat/MessageText';
import { isTag, TAG_SOURCE, tagPath } from '../hashtags';

/**
 * Текст записи или комментария в ленте: `@логин` — ссылка на профиль (своё
 * имя — с подсветкой), адрес http(s) — ссылка, `#тег` в записи — ссылка на
 * ленту тега (в комментариях теги не размечаются — их нет и в ленте тега). Разметки сообщений здесь нет:
 * в записи звёздочки — просто звёздочки. Правила упоминания те же, что на
 * сервере (mentions.js): перед «@» не буква и не цифра, поэтому a@b.ru — почта.
 */
const TOKEN_RE = new RegExp(`(https?:\\/\\/[^\\s<>"«»]+)|(^|[^\\p{L}\\p{N}_@])@([a-z0-9_]{3,20})(?![a-z0-9_])|${TAG_SOURCE}`, 'giu');
// Знаки препинания в конце адреса — это уже фраза; парная скобка остаётся.
const TRAILING = /[.,;:!?…)\]}'»]+$/u;

function trimUrl(raw: string) {
  let url = raw.replace(TRAILING, '');
  const opened = (url.match(/\(/g) ?? []).length;
  const closed = (url.match(/\)/g) ?? []).length;
  if (opened > closed && raw.slice(url.length).startsWith(')')) url += ')';
  return url;
}

export function PostText({ text, hashtags = false }: { text: string; hashtags?: boolean }) {
  const me = useSession().user?.username;
  const out: ReactNode[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    if (m[1]) {
      const url = trimUrl(m[1]);
      if (url.length <= 'https://'.length) continue;
      if (m.index > last) out.push(text.slice(last, m.index));
      const inside = internalPath(url);
      out.push(
        inside ? (
          <Link key={m.index} className="text-link" to={inside}>
            {url}
          </Link>
        ) : (
          <a key={m.index} className="text-link" href={url} target="_blank" rel="noopener noreferrer nofollow">
            {url}
          </a>
        ),
      );
      last = m.index + url.length;
      TOKEN_RE.lastIndex = last;
    } else if (m[5] !== undefined) {
      if (!hashtags || !isTag(m[5])) continue;
      const start = m.index + m[4].length;
      if (start > last) out.push(text.slice(last, start));
      out.push(
        <Link key={start} className="tag-link" to={tagPath(m[5])}>
          #{m[5]}
        </Link>,
      );
      last = start + 1 + m[5].length;
    } else {
      const start = m.index + m[2].length;
      const name = m[3].toLowerCase();
      if (start > last) out.push(text.slice(last, start));
      out.push(
        <Link key={start} className={name === me ? 'mention me' : 'mention'} to={`/u/${name}`}>
          @{m[3]}
        </Link>,
      );
      last = start + 1 + m[3].length;
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
