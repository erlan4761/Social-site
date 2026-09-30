import { useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import { Link } from 'react-router-dom';
import { parseMarkup, type MarkupNode } from './markup';

export { firstUrl } from './markup';

/* ─ Упоминания ───────────────────────────────────────────────────────── */

// То же правило, что в mentions.js на сервере: перед «@» — не буква и не
// цифра, так что адрес почты упоминанием не становится.
const MENTION_RE = /(^|[^\p{L}\p{N}_@])@([a-z0-9_]{3,20})(?![a-z0-9_])/giu;

/** Упоминания в куске обычного текста. */
function withMentions(text: string, me: string | undefined, out: ReactNode[], key: () => number) {
  let last = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index + match[1].length;
    const name = match[2];
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <Link key={key()} className={name.toLowerCase() === me ? 'mention me' : 'mention'} to={`/u/${name.toLowerCase()}`}>
        @{name}
      </Link>,
    );
    last = start + 1 + name.length;
  }
  if (last < text.length) out.push(text.slice(last));
}

/**
 * Спойлер: закрыт узором, пока не нажмут, — как в Телеграме. Закрытый не
 * выделяется и не нажимается изнутри (ссылка под ним не откроется случайно),
 * а скринридер слышит «скрытый текст», а не сам текст.
 */
function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  if (shown) return <span className="spoiler shown">{children}</span>;
  const show = (e: SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShown(true);
  };
  return (
    <span
      className="spoiler"
      role="button"
      tabIndex={0}
      title="Показать"
      onClick={show}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') show(e);
      }}
    >
      <span className="sr-only">Скрытый текст — нажмите, чтобы показать</span>
      <span className="spoiler-text" aria-hidden="true">
        {children}
      </span>
    </span>
  );
}

/**
 * Текст сообщения: разметка (**жирный**, __курсив__, ~~зачёркнутый~~,
 * ||спойлер||, `код`, ```блок``` — см. markup.ts), `@логин` — ссылка на
 * профиль (своё имя — с подсветкой), адреса http(s) — ссылки в новой вкладке.
 * Чужой сайт не узнаёт, откуда пришли (noreferrer), и не получает доступа к
 * нашей вкладке (noopener).
 */
export function MessageText({ text, me }: { text: string; me?: string }) {
  let n = 0;
  const key = () => n++;
  const render = (nodes: MarkupNode[]): ReactNode[] => {
    const out: ReactNode[] = [];
    nodes.forEach((node, i) => {
      switch (node.t) {
        case 'text': {
          // Блок кода и так стоит отдельной строкой: перевод строки вплотную
          // к нему дал бы лишнюю пустую.
          let s = node.s;
          if (nodes[i + 1]?.t === 'pre') s = s.replace(/\n$/, '');
          if (nodes[i - 1]?.t === 'pre') s = s.replace(/^\n/, '');
          withMentions(s, me, out, key);
          break;
        }
        case 'url':
          out.push(
            <a key={key()} className="text-link" href={node.url} target="_blank" rel="noopener noreferrer nofollow">
              {node.url}
            </a>,
          );
          break;
        case 'code':
          out.push(<code key={key()} className="md-code">{node.s}</code>);
          break;
        case 'pre':
          out.push(
            <pre key={key()} className="md-pre">
              <code>{node.s}</code>
            </pre>,
          );
          break;
        case 'bold':
          out.push(<strong key={key()}>{render(node.children)}</strong>);
          break;
        case 'italic':
          out.push(<em key={key()}>{render(node.children)}</em>);
          break;
        case 'strike':
          out.push(<s key={key()}>{render(node.children)}</s>);
          break;
        case 'spoiler':
          out.push(<Spoiler key={key()}>{render(node.children)}</Spoiler>);
          break;
      }
    });
    return out;
  };
  return <>{render(parseMarkup(text))}</>;
}

export const fold = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');

/** Что набрано после «@» прямо перед кареткой — или null, если не упоминание. */
export function mentionQuery(text: string, caret: number) {
  // После «@» — и кириллица: «@ни» находит Нину по имени, а вставится её логин.
  const match = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_]{0,20})$/u.exec(text.slice(0, caret));
  return match ? { q: fold(match[2]), start: caret - match[2].length - 1 } : null;
}
