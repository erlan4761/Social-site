import { useEffect, useRef, useState } from 'react';
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

  // Задержка перед закрытием: без неё клик по результату не успевает
  // сработать раньше onBlur и выпадающий список схлопывается первым.
  function delayedClose() {
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }
  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }

  const showDropdown = open && query.trim().length > 0;

  return (
    <div className="search-box">
      <Glass />
      <input
        type="search"
        placeholder="Найти человека…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={delayedClose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Enter' && results?.[0]) go(results[0].username);
        }}
        aria-label="Поиск людей"
      />

      {showDropdown && (
        <div className="search-results" onMouseDown={cancelClose}>
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
