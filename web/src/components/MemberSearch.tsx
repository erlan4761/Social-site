import { useEffect, useId, useRef, useState } from 'react';
import { api, type Author } from '../api';
import { Monogram } from './Monogram';

const DEBOUNCE_MS = 250;

type Props = {
  /** Подпись поля — своя у создания чата и у добавления в готовый. */
  label: string;
  placeholder?: string;
  /** Кого не предлагать: себя, уже выбранных и тех, кто уже в чате. */
  exclude: string[];
  onPick: (user: Author) => void;
  disabled?: boolean;
};

/**
 * Поиск человека по имени с выбором — общий для окна «Новый чат» и панели
 * участников. От `SearchBox` отличается тем, что не уводит на профиль, а
 * отдаёт выбранного наверх и умеет прятать тех, кто уже в списке: сервер на
 * повторное добавление отвечает 400, и показывать такую строку незачем.
 */
export function MemberSearch({ label, placeholder, exclude, onPick, disabled = false }: Props) {
  const fieldId = useId();
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

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  // Отсев считается при отрисовке, а не в эффекте: список исключений меняется
  // с каждым выбором, и перезапрашивать сервер из-за этого не нужно.
  const hidden = new Set(exclude);
  const visible = results?.filter((u) => !hidden.has(u.username)) ?? null;

  function pick(user: Author) {
    setOpen(false);
    setQuery('');
    setResults(null);
    onPick(user);
  }

  // Та же задержка, что в общем поиске: без неё onBlur схлопывает список
  // раньше, чем клик по строке успевает сработать.
  function delayedClose() {
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }

  const showDropdown = open && query.trim().length > 0 && !disabled;

  return (
    <div className="member-search">
      <label className="member-search-label" htmlFor={fieldId}>
        {label}
      </label>

      <div className="search-box">
        <input
          id={fieldId}
          type="search"
          autoComplete="off"
          value={query}
          disabled={disabled}
          placeholder={placeholder ?? 'Имя или @логин'}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={delayedClose}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
            // Enter внутри окна создания чата не должен отправлять форму:
            // здесь он выбирает первого найденного.
            if (e.key === 'Enter') {
              e.preventDefault();
              if (visible?.[0]) pick(visible[0]);
            }
          }}
        />

        {showDropdown && (
          <div
            className="search-results"
            onMouseDown={() => {
              if (closeTimer.current) clearTimeout(closeTimer.current);
            }}
          >
            {visible === null ? (
              <p className="search-empty">Ищу…</p>
            ) : visible.length === 0 ? (
              <p className="search-empty">Никого не нашлось</p>
            ) : (
              visible.map((u) => (
                <button key={u.id} type="button" className="search-hit" onClick={() => pick(u)}>
                  <Monogram
                    username={u.username}
                    displayName={u.displayName}
                    avatarUrl={u.avatarUrl}
                    size="sm"
                  />
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
    </div>
  );
}
