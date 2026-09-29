import { useEffect, useRef, useState } from 'react';
import { type ConversationHit } from '../../api';
import { clockTime, dayLabel, plural } from '../../time';
import { highlight, searchTerms } from '../../highlight';
import { Icon } from '../Icon';
import { oneLine } from './format';

/* ─ Поиск внутри переписки ───────────────────────────────────────────── */

/** Запрос уходит после паузы в наборе, а не на каждую букву. */
const SEARCH_DEBOUNCE_MS = 300;

type SearchProps = {
  onSearch: (q: string) => Promise<ConversationHit[]>;
  onPick: (id: number) => void;
  onClose: () => void;
};

/**
 * Поиск по открытой переписке: строка под шапкой и список найденного,
 * свежее сверху. Выбор — переход к сообщению в ленте, с догрузкой старых.
 */
export function ConversationSearch({ onSearch, onPick, onClose }: SearchProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ConversationHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const terms = searchTerms(query);
  const search = useRef(onSearch);
  search.current = onSearch;

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search.current(q)
        .then((res) => {
          if (!cancelled) {
            setHits(res);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Поиск не удался');
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <section className="pane-panel conv-search" aria-label="Поиск по переписке">
      <div className="conv-search-bar">
        <label className="list-search">
          <Icon name="search" size={18} />
          <span className="sr-only">Найти в переписке</span>
          <input
            type="search"
            value={query}
            placeholder="Найти в переписке"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
          />
        </label>
        <button className="btn ghost small" type="button" onClick={onClose}>
          Закрыть
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {hits && (
        <p className="conv-search-count" aria-live="polite">
          {hits.length === 0
            ? 'Ничего не нашлось'
            : `${hits.length} ${plural(hits.length, 'сообщение', 'сообщения', 'сообщений')}${hits.length >= 50 ? ' — показаны последние' : ''}`}
        </p>
      )}

      {hits && hits.length > 0 && (
        <ul className="conv-search-hits">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => onPick(h.id)}>
                <span className="conv-hit-head">
                  <strong>{h.author?.displayName ?? 'Публикация'}</strong>
                  <time dateTime={h.createdAt}>{dayLabel(h.createdAt)}, {clockTime(h.createdAt)}</time>
                </span>
                <span className="conv-hit-body">{highlight(oneLine(h.body), terms)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
