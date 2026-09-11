import { useEffect, useRef, useState } from 'react';
import type { FocusEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Author } from '../api';
import { Monogram } from './Monogram';

const DEBOUNCE_MS = 250;

function Glass() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.4 10.4 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function SearchBox() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Author[] | null>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .searchUsers(q)
        .then((res) => !cancelled && setResults(res.users))
        .catch(() => !cancelled && setResults([]));
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  function go(username: string) {
    setOpen(false);
    setQuery('');
    setResults(null);
    navigate(`/u/${username}`);
  }

  /**
   * Enter уводит на экран поиска, а не в профиль первого попавшегося человека:
   * запись искать здесь так же законно, как и людей, а угадывать за человека,
   * чего он хотел, — худший из двух вариантов. Строка в поле остаётся: с неё
   * удобно уточнять запрос.
   */
  function goSearch() {
    const q = query.trim();
    if (!q) return;
    setOpen(false);
    setResults(null);
    navigate(`/search?q=${encodeURIComponent(q)}`);
  }

  // Задержка перед закрытием: без неё клик по результату не успевает
  // сработать раньше onBlur и выпадающий список схлопывается первым.
  // Уход фокуса **внутрь** списка не закрывает его вовсе: иначе Tab с поля
  // на первую строку («искать среди записей») уносил бы её из-под фокуса.
  function delayedClose(event: FocusEvent<HTMLElement>) {
    if (box.current?.contains(event.relatedTarget)) return;
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }
  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }

  const showDropdown = open && query.trim().length > 0;

  return (
    <div className="search-box" ref={box} onBlur={delayedClose}>
      <Glass />
      <input
        type="search"
        placeholder="Найти запись или человека…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Enter') goSearch();
        }}
        aria-label="Поиск по записям и людям"
      />

      {showDropdown && (
        <div className="search-results" onMouseDown={cancelClose}>
          <button type="button" className="search-hit search-all" onClick={goSearch}>
            <Glass />
            <span>
              Искать <strong>«{query.trim()}»</strong> среди записей
            </span>
          </button>

          {results === null ? (
            <p className="search-empty">Ищу…</p>
          ) : results.length === 0 ? (
            <p className="search-empty">Никого не нашлось</p>
          ) : (
            results.map((u) => (
              <button key={u.id} type="button" className="search-hit" onClick={() => go(u.username)}>
                <Monogram username={u.username} displayName={u.displayName} avatarUrl={u.avatarUrl} size="sm" />
                <span>
                  <strong>{u.displayName}</strong>
                  <span className="search-hit-handle">@{u.username}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
