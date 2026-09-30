import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CallProvider } from '../calls';
import { Link, NavLink, Outlet, useMatch, useNavigate } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { Monogram } from './Monogram';
import { SearchBox } from './SearchBox';
import { useSession } from '../session';
import { readTheme, setTheme, THEME_CHOICES, THEME_LABELS, type ThemeChoice } from '../theme';

const REPO = 'https://github.com/erlan4761/Social-site';

/* Точки перелома — те же три, что записаны в дизайн-системе. В CSS они
   повторены числами: медиазапросы не умеют читать кастомные свойства.
     < 46rem   телефон  — одна колонка, липкая шапка, нижний таб-бар;
     46…78rem  планшет  — узкая полоса иконок, липкая шапка, правой зоны нет;
     >= 78rem  десктоп  — три зоны.
   Зачем это ещё и в JS, а не только в CSS: чтобы в DOM существовала ровно
   одна навигация. Спрятанный display:none дубль не читает диктор, но он
   мешает и тестам, и будущему слоту правой зоны (архив из FE-04 обязан
   рендериться один раз). */
const WIDE = '(min-width: 78rem)';
const PHONE = '(max-width: 46rem)';

function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof matchMedia !== 'function') return () => {};
      const media = matchMedia(query);
      media.addEventListener('change', notify);
      return () => media.removeEventListener('change', notify);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => (typeof matchMedia === 'function' ? matchMedia(query).matches : false),
    () => false,
  );
}

/* ─ Слот правой зоны ───────────────────────────────────────────────────
   Экран может отдать в правую колонку свой блок (FE-04 — панель «Архив»).
   На широком экране он уезжает туда порталом, на узком остаётся там, где
   его написали. Важное свойство: узел один и тот же, поэтому
   `document.querySelectorAll('.archive').length === 1` при любой ширине. */
const AsideSlotContext = createContext<HTMLElement | null>(null);

export function AsideSlot({ children }: { children: ReactNode }) {
  const target = useContext(AsideSlotContext);
  if (!target) return <>{children}</>;
  return createPortal(children, target);
}

/* ─ Навигация ─────────────────────────────────────────────────────────── */
type NavItem = {
  to: string;
  end?: boolean;
  label: string;
  /** Подпись в нижнем таб-баре: там места на одно слово. */
  short?: string;
  icon: IconName;
  badge?: number;
  /** Что диктор произносит после числа: «3 непрочитанных». */
  badgeHint?: string;
};

function NavBadge({ count, hint }: { count: number; hint: string }) {
  return (
    <span className="badge">
      {count}
      <span className="sr-only"> {hint}</span>
    </span>
  );
}

/* ─ Переключатель темы ────────────────────────────────────────────────
   Три положения, каждое — обычная кнопка с aria-pressed. Радиокнопки были
   бы формально точнее, но здесь нет формы и нечего отправлять, а кнопка
   сразу применяет выбор. В режиме «как в системе» theme.ts снимает
   data-theme, и дальше тему решает prefers-color-scheme. */
const THEME_ICONS: Record<ThemeChoice, IconName> = {
  light: 'sun',
  dark: 'moon',
  auto: 'monitor',
};

function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [choice, setChoice] = useState<ThemeChoice>(() => readTheme());

  return (
    <div
      className={compact ? 'theme-toggle compact' : 'theme-toggle'}
      role="group"
      aria-label="Тема оформления"
    >
      {THEME_CHOICES.map((option) => (
        <button
          key={option}
          type="button"
          className="theme-opt"
          aria-pressed={choice === option}
          title={THEME_LABELS[option]}
          onClick={() => {
            setTheme(option);
            setChoice(option);
          }}
        >
          <Icon name={THEME_ICONS[option]} size={18} />
          <span className={compact ? 'sr-only' : 'theme-opt-label'}>{THEME_LABELS[option]}</span>
        </button>
      ))}
    </div>
  );
}

/* ─ Карточка пользователя с меню ──────────────────────────────────────
   Esc и клик мимо закрывают, фокус возвращается на кнопку — то же
   поведение, что у модалок проекта. */
function UserMenu({ withTheme, variant }: { withTheme: boolean; variant: 'card' | 'button' }) {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    }
    function onPointer(event: MouseEvent) {
      if (wrap.current?.contains(event.target as Node)) return;
      setOpen(false);
    }

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div className={variant === 'card' ? 'usermenu card' : 'usermenu'} ref={wrap}>
      <button
        type="button"
        className="usermenu-trigger"
        ref={trigger}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={open ? 'Закрыть меню пользователя' : 'Меню пользователя'}
        onClick={() => setOpen((was) => !was)}
      >
        <Monogram
          username={user.username}
          displayName={user.displayName}
          avatarUrl={user.avatarUrl}
          size={variant === 'card' ? 'md' : 'sm'}
        />
        {variant === 'card' && (
          <span className="usermenu-who">
            <strong>{user.displayName}</strong>
            <span className="usermenu-handle">@{user.username}</span>
          </span>
        )}
        <Icon name="chevron-down" size={16} className="usermenu-caret" />
      </button>

      {open && (
        <div className="usermenu-pop" role="menu">
          <Link
            className="usermenu-row"
            role="menuitem"
            to={`/u/${user.username}`}
            onClick={() => setOpen(false)}
          >
            <Icon name="user" />
            Мой профиль
          </Link>
          <Link className="usermenu-row" role="menuitem" to="/settings" onClick={() => setOpen(false)}>
            <Icon name="settings" />
            Настройки
          </Link>
          {user.moderator && (
            <Link className="usermenu-row" role="menuitem" to="/moderation" onClick={() => setOpen(false)}>
              <Icon name="flag" />
              Жалобы
            </Link>
          )}

          {withTheme && (
            <div className="usermenu-theme">
              <p className="usermenu-cap">Оформление</p>
              <ThemeToggle />
            </div>
          )}

          <button
            type="button"
            className="usermenu-row danger"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            <Icon name="logout" />
            Выйти
          </button>
        </div>
      )}
    </div>
  );
}

/* ─ Оболочка ──────────────────────────────────────────────────────────── */
export function Shell() {
  return (
    <CallProvider>
      <ShellLayout />
    </CallProvider>
  );
}

function ShellLayout() {
  const { user, unreadTotal, notifUnread } = useSession();
  const wide = useMedia(WIDE);
  const phone = useMedia(PHONE);
  const [asideSlot, setAsideSlot] = useState<HTMLElement | null>(null);
  // Мессенджер забирает себе всю ширину справа от навигации: две его колонки
  // и есть содержимое экрана. Открытая переписка на телефоне — весь экран,
  // без шапки и таб-бара, как в любом мессенджере.
  const messenger = useMatch('/messages/*') != null;
  const conversation = useMatch('/messages/:first/*') != null;
  const fullscreenChat = phone && conversation;

  const items: NavItem[] = [
    { to: '/', end: true, label: 'Лента', icon: 'feed' },
    { to: '/bookmarks', label: 'Закладки', icon: 'bookmark' },
    {
      to: '/messages',
      label: 'Сообщения',
      icon: 'message',
      badge: unreadTotal,
      badgeHint: 'непрочитанных',
    },
    {
      to: '/notifications',
      label: 'События',
      icon: 'bell',
      badge: notifUnread,
      badgeHint: 'новых',
    },
  ];
  if (user) {
    items.push({ to: `/u/${user.username}`, label: 'Мой профиль', short: 'Профиль', icon: 'user' });
  }
  // Жалобы — только модераторам; на телефоне пункт не помещается в таб-бар
  // и живёт в меню пользователя вместе с настройками.
  if (user?.moderator && !phone) items.push({ to: '/moderation', label: 'Жалобы', icon: 'flag' });

  return (
    <>
      {/* Первая остановка Tab на странице. Видна только в фокусе. */}
      <a className="skip-link" href="#content">
        Перейти к содержимому
      </a>

      <div className={messenger ? (conversation ? 'shell messenger-mode in-conversation' : 'shell messenger-mode') : 'shell'}>
        {!wide && !fullscreenChat && (
          <header className="topbar">
            <Link className="wordmark" to="/">
              хроника
            </Link>
            <div className="topbar-search">
              <SearchBox />
            </div>
            <ThemeToggle compact />
            <UserMenu withTheme={false} variant="button" />
          </header>
        )}

        {!phone && (
          <header className={wide ? 'sidebar' : 'sidebar narrow'}>
            {wide && (
              <>
                <Link className="wordmark" to="/">
                  хроника
                </Link>
                <div className="search-slot">
                  <SearchBox />
                </div>
              </>
            )}

            <nav className="nav" aria-label="Основные разделы">
              {items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className="nav-item"
                  /* На узкой полосе подписи нет, а число непрочитанного
                     показано точкой — значит, и то и другое обязано быть
                     в доступном имени ссылки. */
                  aria-label={
                    wide
                      ? undefined
                      : item.badge
                        ? `${item.label}, ${item.badge} ${item.badgeHint ?? ''}`.trim()
                        : item.label
                  }
                  title={wide ? undefined : item.label}
                >
                  <span className="nav-ico">
                    <Icon name={item.icon} size={22} />
                    {!wide && item.badge ? <span className="nav-dot" /> : null}
                  </span>
                  {wide && <span className="nav-label">{item.label}</span>}
                  {wide && item.badge ? (
                    <NavBadge count={item.badge} hint={item.badgeHint ?? ''} />
                  ) : null}
                </NavLink>
              ))}
            </nav>

            {wide && (
              <div className="sidebar-foot">
                <UserMenu withTheme variant="card" />
              </div>
            )}
          </header>
        )}

        <main className="main" id="content" tabIndex={-1}>
          <AsideSlotContext.Provider value={asideSlot}>
            <Outlet />
          </AsideSlotContext.Provider>
        </main>

        {wide && user && !messenger && (
          <aside className="aside" aria-label="О вас">
            <div className="aside-card me">
              <Link className="me-head" to={`/u/${user.username}`}>
                <Monogram
                  username={user.username}
                  displayName={user.displayName}
                  avatarUrl={user.avatarUrl}
                  size="md"
                />
                <span className="me-who">
                  <strong>{user.displayName}</strong>
                  <span className="me-handle">@{user.username}</span>
                </span>
              </Link>
              {user.bio ? <p className="me-bio">{user.bio}</p> : null}
            </div>

            <div className="aside-card">
              <h2 className="aside-title">Коротко</h2>
              <ul className="aside-links">
                <li>
                  <Link to="/messages">
                    <Icon name="message" />
                    Сообщения
                    {unreadTotal > 0 && <NavBadge count={unreadTotal} hint="непрочитанных" />}
                  </Link>
                </li>
                <li>
                  <Link to="/notifications">
                    <Icon name="bell" />
                    События
                    {notifUnread > 0 && <NavBadge count={notifUnread} hint="новых" />}
                  </Link>
                </li>
                <li>
                  <Link to="/bookmarks">
                    <Icon name="bookmark" />
                    Закладки
                  </Link>
                </li>
              </ul>
            </div>

            {/* Сюда экраны отдают свой блок через <AsideSlot>. Пустым не
                висит: без содержимого у него нулевая высота и нет рамки. */}
            <div className="aside-slot" ref={setAsideSlot} />

            <p className="aside-foot">
              «Хроника» — спокойный дневник.{' '}
              <a href={REPO} target="_blank" rel="noreferrer">
                Исходный код
              </a>
            </p>
          </aside>
        )}

        {phone && !fullscreenChat && (
          <nav className="tabbar" aria-label="Основные разделы">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className="tab"
                /* Имя целиком на ссылке: иначе диктор прочтёт бейдж раньше
                   подписи — «3 непрочитанных Сообщения». */
                aria-label={
                  item.badge
                    ? `${item.label}, ${item.badge} ${item.badgeHint ?? ''}`.trim()
                    : item.label
                }
              >
                <span className="nav-ico">
                  <Icon name={item.icon} size={22} />
                  {item.badge ? (
                    <span className="badge tab-badge">
                      {item.badge}
                      <span className="sr-only"> {item.badgeHint}</span>
                    </span>
                  ) : null}
                </span>
                <span className="tab-label">{item.short ?? item.label}</span>
              </NavLink>
            ))}
          </nav>
        )}
      </div>
    </>
  );
}
