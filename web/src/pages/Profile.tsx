import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, type ArchiveMonth, type BlockedUser, type User, type Post } from '../api';
import { ArchivePanel } from '../components/ArchivePanel';
import { Monogram } from '../components/Monogram';
import { FollowListDialog, type FollowSide } from '../components/FollowListDialog';
import { PostRow } from '../components/PostRow';
import { Icon } from '../components/Icon';
import { LINKS_MAX, linkLabel, normalizeLinks } from '../profileLinks';
import { ReportDialog } from '../components/ReportDialog';
import { useSession } from '../session';
import { joinedOn, monthLabel, plural, yearOf } from '../time';
import { formatPhone } from '../phone';
import { usePostStream } from '../usePostStream';

const YEAR_ONLY = /^\d{4}$/;

/** `'2026'` → «2026 год», `'2026-09'` → «Сентябрь 2026». Мусор — как есть:
 *  период человек видит в адресе, и подменять его выдумкой нечестно. */
const periodTitle = (period: string) => (YEAR_ONLY.test(period) ? `${period} год` : monthLabel(period));

export function Profile() {
  const { username = '' } = useParams();
  const { user: me, setUser, refreshBadges } = useSession();
  const [profile, setProfile] = useState<User | null>(null);
  /** Закреплённая запись — наверху ленты профиля, пока не выбран период. */
  const [pinned, setPinned] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [followList, setFollowList] = useState<FollowSide | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  // Блокировка меняет выдачу сервера, а адрес страницы остаётся прежним —
  // ленту профиля приходится просить заново.
  const [reloadKey, setReloadKey] = useState(0);
  const [archive, setArchive] = useState<{ months: ArchiveMonth[]; total: number }>({ months: [], total: 0 });
  // Выбранный месяц живёт в адресе, а не в состоянии: иначе «назад» в браузере
  // и перезагрузка страницы показывали бы не то, что обещает ссылка.
  const [params, setParams] = useSearchParams();
  const period = params.get('period') ?? '';
  const stream = usePostStream({ author: username, period: period || undefined, reloadKey });

  /** Пуск с `null` снимает фильтр. Не `replace`: «назад» обязан вернуть ленту целиком. */
  function pickPeriod(next: string | null) {
    const updated = new URLSearchParams(params);
    if (next) updated.set('period', next);
    else updated.delete('period');
    setParams(updated);
  }

  useEffect(() => {
    let cancelled = false;
    setArchive({ months: [], total: 0 });

    api
      .archive(username)
      // Молча: не открывшийся архив — не повод показывать ошибку поверх
      // профиля, лента при этом на месте.
      .then((res) => !cancelled && setArchive(res))
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [username, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setPinned(null);
    setError(null);
    setEditing(false);

    api
      .profile(username)
      .then((res) => {
        if (cancelled) return;
        setProfile(res.user);
        setPinned(res.pinnedPost ?? null);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Ошибка загрузки'));

    return () => {
      cancelled = true;
    };
  }, [username]);

  /**
   * Правка записи в профиле: та же, что в ленте, плюс закрепление — запись
   * переезжает наверх (прежняя закреплённая теряет флаг) или возвращается в
   * общий порядок. Откат неудачного запроса приходит сюда же обратным флагом.
   */
  function patchPost(id: number, changes: Partial<Post>) {
    stream.patch(id, changes);
    if (changes.pinned === true) {
      if (pinned && pinned.id !== id) stream.patch(pinned.id, { pinned: false });
      const base = pinned?.id === id ? pinned : stream.posts.find((x) => x.id === id);
      if (base) setPinned({ ...base, ...changes });
    } else if (changes.pinned === false) {
      if (pinned?.id === id) setPinned(null);
    } else if (pinned?.id === id) {
      setPinned({ ...pinned, ...changes });
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!profile) return <p className="empty" style={{ marginLeft: 0 }}>Загружаю…</p>;

  const isMe = me?.id === profile.id;
  const count = profile.postCount ?? 0;
  // Год покрывает свои месяцы префиксом строки — тем же сравнением, что и на
  // сервере, поэтому число над лентой сходится с числом в панели.
  const periodCount = archive.months
    .filter((m) => m.month.startsWith(period))
    .reduce((sum, m) => sum + m.count, 0);
  // Шаг «раньше / позже» — по годам, если выбран год, и по месяцам иначе.
  // Список идёт от новых к старым, поэтому «раньше» — это следующий элемент.
  const steps = YEAR_ONLY.test(period)
    ? [...new Set(archive.months.map((m) => yearOf(m.month)))]
    : archive.months.map((m) => m.month);
  const at = steps.indexOf(period);
  const earlier = at >= 0 ? steps[at + 1] : undefined;
  const later = at > 0 ? steps[at - 1] : undefined;
  // Закреплённая — наверху и только во всей ленте: в выбранном месяце её
  // место там, где она написана. Ниже, в общем порядке, она не повторяется.
  const showPinned = pinned != null && !period;
  const listed = showPinned ? stream.posts.filter((x) => x.id !== pinned.id) : stream.posts;
  const followers = profile.followerCount ?? 0;
  const following = profile.followingCount ?? 0;

  /** Подписались или отписались в списке — у своего профиля меняется «подписки». */
  async function refreshCounts() {
    if (!profile) return;
    try {
      const res = await api.profile(profile.username);
      setProfile((p) => (p ? { ...p, followerCount: res.user.followerCount, followingCount: res.user.followingCount, followedByMe: res.user.followedByMe } : p));
    } catch {
      // счётчики подтянутся при следующем открытии профиля
    }
  }

  async function toggleFollow() {
    if (!profile || followBusy) return;
    // Заявка на закрытый профиль отзывается той же кнопкой.
    const next = !(profile.followedByMe || profile.requestedByMe);
    const wasRequested = Boolean(profile.requestedByMe);

    setFollowBusy(true);
    setFollowError(null);
    // Optimistic: the button answers the click, then the server confirms.
    // У закрытого профиля счётчик не меняется: заявка — ещё не подписка.
    setProfile((p) =>
      p
        ? p.private && !p.followedByMe
          ? { ...p, requestedByMe: next }
          : { ...p, followedByMe: next, followerCount: (p.followerCount ?? 0) + (next ? 1 : -1) }
        : p,
    );

    try {
      const res = await api.setFollow(profile.username, next);
      const nowFollowing = res.followedByMe;
      setProfile((p) =>
        p
          ? {
              ...p,
              followedByMe: nowFollowing,
              requestedByMe: Boolean(res.requested),
              followerCount: res.followerCount,
              // Отписка от закрытого прячет его записи сразу.
              canSeePosts: p.private ? nowFollowing : p.canSeePosts,
            }
          : p,
      );
      if (profile.private && !nowFollowing && profile.followedByMe) setReloadKey((k) => k + 1);
    } catch (err) {
      setProfile((p) => (p ? { ...p, followedByMe: !next && !wasRequested, requestedByMe: wasRequested, followerCount: followers } : p));
      setFollowError(err instanceof ApiError ? err.message : 'Не удалось изменить подписку');
    } finally {
      setFollowBusy(false);
    }
  }

  /**
   * Блокировка необратима по последствиям: сервер в той же операции снимает
   * взаимные подписки и гасит непрочитанные события — «отменить» их нечем.
   * Поэтому спрашиваем подтверждение, а на снятие блокировки — не спрашиваем.
   */
  async function setBlock(next: boolean) {
    if (!profile || blockBusy) return;

    if (next) {
      const ok = window.confirm(
        `Заблокировать @${profile.username}?\n\n` +
          'Взаимные подписки будут сняты — обратно они не вернутся. ' +
          'Его записи и ответы скроются, переписка станет недоступна обеим сторонам.',
      );
      if (!ok) return;
    }

    setBlockBusy(true);
    setBlockError(null);
    try {
      await api.setBlock(profile.username, next);
      // Одним действием меняются подписки, счётчики записей и флаги —
      // проще перечитать профиль целиком, чем угадывать новое состояние.
      const res = await api.profile(profile.username);
      setProfile(res.user);
      setReloadKey((k) => k + 1);
      refreshBadges();
    } catch (err) {
      setBlockError(err instanceof ApiError ? err.message : 'Не удалось изменить блокировку');
    } finally {
      setBlockBusy(false);
    }
  }

  return (
    <>
      {followList && (
        <FollowListDialog
          username={profile.username}
          side={followList}
          counts={{ followers, following }}
          onClose={() => setFollowList(null)}
          onChanged={() => void refreshCounts()}
        />
      )}
      {profile.coverUrl && <img className="profile-cover" src={profile.coverUrl} alt="" />}
      <div className="profile-head">
        {isMe ? (
          <AvatarEditor
            profile={profile}
            onChanged={(updated) => {
              setProfile((p) => (p ? { ...p, avatarUrl: updated.avatarUrl } : p));
              setUser(updated);
              // Посты в ленте несут снимок автора на момент загрузки — без этого
              // под новым фото в шапке остались бы старые инициалы.
              for (const post of stream.posts) {
                if (post.author.id === updated.id) {
                  stream.patch(post.id, { author: { ...post.author, avatarUrl: updated.avatarUrl } });
                }
              }
            }}
          />
        ) : (
          <Monogram username={profile.username} displayName={profile.displayName} avatarUrl={profile.avatarUrl} size="lg" />
        )}

        <div className="profile-body">
          {editing && isMe ? (
            <ProfileForm
              profile={profile}
              onCancel={() => setEditing(false)}
              onSaved={(updated) => {
                // Слиянием, а не заменой: в ответе правки нет счётчиков и
                // флагов профиля — без этого после «Сохранить» было бы «0 подписчиков».
                setProfile((p) => (p ? { ...p, ...updated, postCount: count } : p));
                setUser(updated);
                setEditing(false);
              }}
              onCover={(updated) => setProfile((p) => (p ? { ...p, coverUrl: updated.coverUrl ?? null } : p))}
            />
          ) : (
            <>
              <h1 className="profile-name">
                {profile.displayName}
                {profile.private && (
                  <span className="profile-lock" title="Закрытый профиль: записи видят только подписчики" role="img" aria-label="Закрытый профиль">
                    <Icon name="lock" size={18} />
                  </span>
                )}
              </h1>
              <p className="profile-handle">@{profile.username}</p>
              {profile.phone && (
                <p className="profile-phone">
                  <a href={`tel:${profile.phone}`}>{formatPhone(profile.phone)}</a>
                </p>
              )}
              {profile.bio && <p className="profile-bio">{profile.bio}</p>}
              {profile.links && profile.links.length > 0 && (
                <ul className="profile-links">
                  {profile.links.map((href) => (
                    <li key={href}>
                      <a href={href} target="_blank" rel="me noopener noreferrer nofollow">
                        <Icon name="link" size={15} />
                        {linkLabel(href)}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <p className="profile-meta">
                <span>
                  {count} {plural(count, 'пост', 'поста', 'постов')}
                </span>
                <button className="profile-count" type="button" onClick={() => setFollowList('followers')}>
                  {followers} {plural(followers, 'подписчик', 'подписчика', 'подписчиков')}
                </button>
                <button className="profile-count" type="button" onClick={() => setFollowList('following')}>
                  {following} {plural(following, 'подписка', 'подписки', 'подписок')}
                </button>
                <span>с {joinedOn(profile.createdAt)}</span>
              </p>

              {followError && <p className="error">{followError}</p>}
              {blockError && <p className="error">{blockError}</p>}

              {profile.blockedByMe && (
                <div className="notice danger">
                  <p>
                    Вы заблокировали @{profile.username}. Он не может вам писать, а его записи скрыты.
                  </p>
                  <button
                    className="btn ghost small"
                    type="button"
                    onClick={() => void setBlock(false)}
                    disabled={blockBusy}
                  >
                    {blockBusy ? 'Снимаю…' : 'Разблокировать'}
                  </button>
                </div>
              )}

              {/* Про чужое решение — ни слова о причинах и о том, кто его принял. */}
              {profile.blocksMe && !profile.blockedByMe && (
                <div className="notice">
                  <p>Профиль сейчас недоступен: записи скрыты, написать нельзя.</p>
                </div>
              )}

              <div className="profile-actions">
                {isMe ? (
                  <>
                    <button className="btn ghost" type="button" onClick={() => setEditing(true)}>
                      Редактировать профиль
                    </button>
                    {profile.private && (
                      <Link className="btn ghost" to="/requests">
                        Заявки на подписку
                      </Link>
                    )}
                  </>
                ) : (
                  <>
                    {!profile.blockedByMe && !profile.blocksMe && (
                      <>
                        <button
                          className={profile.followedByMe || profile.requestedByMe ? 'btn ghost' : 'btn'}
                          type="button"
                          onClick={() => void toggleFollow()}
                          disabled={followBusy}
                          title={profile.requestedByMe ? 'Нажмите, чтобы отозвать заявку' : undefined}
                        >
                          {profile.followedByMe
                            ? 'Отписаться'
                            : profile.requestedByMe
                              ? 'Заявка отправлена'
                              : profile.private
                                ? 'Попросить подписку'
                                : 'Подписаться'}
                        </button>
                        <Link className="btn ghost" to={`/messages/${profile.username}`}>
                          Написать
                        </Link>
                      </>
                    )}

                    <button className="act-danger" type="button" onClick={() => setReporting(true)}>
                      Пожаловаться
                    </button>

                    {!profile.blockedByMe && (
                      <button
                        className="act-danger"
                        type="button"
                        onClick={() => void setBlock(true)}
                        disabled={blockBusy}
                      >
                        Заблокировать
                      </button>
                    )}
                  </>
                )}
              </div>

              {isMe && <BlockedPanel />}

              {reporting && (
                <ReportDialog
                  targetType="user"
                  targetId={profile.id}
                  subject={`Профиль @${profile.username}`}
                  onClose={() => setReporting(false)}
                />
              )}
            </>
          )}
        </div>
      </div>

      {archive.total > 0 && (
        <ArchivePanel months={archive.months} total={archive.total} active={period} onPick={pickPeriod} />
      )}

      {period && (
        <div className="period-bar">
          <p className="period-what">
            <strong>{periodTitle(period)}</strong>
            <span>
              {periodCount} {plural(periodCount, 'запись', 'записи', 'записей')}
            </span>
          </p>

          <div className="period-nav">
            {/* Стрелки ходят по списку месяцев из архива, а не по календарю:
                пустой месяц между двумя записями открывать незачем. */}
            <button
              className="act"
              type="button"
              onClick={() => earlier && pickPeriod(earlier)}
              disabled={!earlier}
            >
              <span aria-hidden="true">←</span> Раньше
            </button>
            <button className="act" type="button" onClick={() => later && pickPeriod(later)} disabled={!later}>
              Позже <span aria-hidden="true">→</span>
            </button>
            <button className="btn ghost small" type="button" onClick={() => pickPeriod(null)}>
              Показать всё
            </button>
          </div>
        </div>
      )}

      <div className="rail">
        {stream.error && <p className="error">{stream.error}</p>}

        {stream.loading ? (
          <p className="empty">Загружаю…</p>
        ) : !isMe && profile.private && profile.canSeePosts === false && !profile.blockedByMe && !profile.blocksMe ? (
          <p className="empty">
            <strong>Это закрытый профиль.</strong>
            {profile.requestedByMe
              ? 'Заявка отправлена — записи откроются, когда владелец её примет.'
              : 'Записи видят только подписчики, которых принял владелец. Попросите подписку.'}
          </p>
        ) : stream.posts.length === 0 && !showPinned ? (
          // Пустая лента у заблокированного — не «постов нет», а «их не видно»:
          // подменять причину значит врать человеку о его же действии.
          profile.blockedByMe || profile.blocksMe ? (
            <p className="empty">
              <strong>Записи скрыты.</strong>
              Они появятся снова, если блокировка будет снята.
            </p>
          ) : period ? (
            <p className="empty">
              <strong>За этот период записей нет.</strong>
              Выберите другой месяц в архиве или вернитесь ко всей ленте.
            </p>
          ) : (
            <p className="empty">
              <strong>{isMe ? 'Вы ещё ничего не написали.' : 'Постов пока нет.'}</strong>
              {isMe ? 'Первая запись появится здесь.' : 'Загляните позже.'}
            </p>
          )
        ) : (
          [...(showPinned ? [pinned] : []), ...listed].map((post) => (
            <PostRow
              key={post.id}
              post={post}
              pinnedMark={showPinned && post.id === pinned.id}
              canDelete={isMe}
              onPatch={patchPost}
              onDelete={async (id) => {
                if (pinned?.id === id) setPinned(null);
                const month = post.createdAt.slice(0, 7);
                if (!(await stream.remove(id))) return;
                setProfile((p) => (p ? { ...p, postCount: Math.max(0, (p.postCount ?? 1) - 1) } : p));
                // Число в архиве обязано совпадать с тем, что откроется по клику,
                // — иначе месяц обещал бы записи, которых уже нет.
                setArchive((a) => ({
                  total: Math.max(0, a.total - 1),
                  months: a.months
                    .map((m) => (m.month === month ? { ...m, count: m.count - 1 } : m))
                    .filter((m) => m.count > 0),
                }));
              }}
            />
          ))
        )}
      </div>

      {stream.hasMore && (
        <div className="more">
          <button className="btn ghost" type="button" onClick={stream.loadMore} disabled={stream.loadingMore}>
            {stream.loadingMore ? 'Загружаю…' : 'Показать ещё'}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Список заблокированных на своём профиле.
 *
 * Отдельной страницы намеренно нет: раздел раскрывается на месте, и попасть в
 * него можно за один клик — ровно то, чего просила задача, без пятого маршрута.
 * Пока никого не заблокировано, раздела не видно: строка «Заблокированные — 0»
 * ничего не сообщает, а место занимает.
 */
function BlockedPanel() {
  const [users, setUsers] = useState<BlockedUser[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .blockedUsers()
      .then((res) => !cancelled && setUsers(res.users))
      // Молча: не открывшийся список блокировок — не повод показывать ошибку
      // поверх собственного профиля.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function unblock(username: string) {
    setBusy(username);
    setError(null);
    try {
      await api.setBlock(username, false);
      setUsers((prev) => prev?.filter((u) => u.username !== username) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось снять блокировку');
    } finally {
      setBusy(null);
    }
  }

  if (!users || users.length === 0) return null;

  return (
    <div className="blocked">
      <button
        className={open ? 'act open' : 'act'}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Заблокированные — {users.length}
      </button>

      {open && (
        <>
          {error && <p className="error">{error}</p>}

          <ul className="blocked-list">
            {users.map((u) => (
              <li key={u.id}>
                <Monogram
                  username={u.username}
                  displayName={u.displayName}
                  avatarUrl={u.avatarUrl}
                  size="sm"
                />
                <Link className="blocked-who" to={`/u/${u.username}`}>
                  <strong>{u.displayName}</strong>
                  <span className="blocked-handle">@{u.username}</span>
                </Link>
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() => void unblock(u.username)}
                  disabled={busy === u.username}
                >
                  {busy === u.username ? 'Снимаю…' : 'Разблокировать'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const MAX_AVATAR = 5 * 1024 * 1024;

/** Own avatar: click the photo to replace it, no form to save. */
function AvatarEditor({ profile, onChanged }: { profile: User; onChanged: (user: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File | null) {
    if (!file) return;
    setError(null);

    if (!file.type.startsWith('image/')) {
      setError('Аватар — только изображение');
      return;
    }
    if (file.size > MAX_AVATAR) {
      setError('Изображение больше 5 МБ');
      return;
    }

    setBusy(true);
    try {
      const res = await api.setAvatar(file);
      onChanged(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.removeAvatar();
      onChanged(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось убрать фото');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="avatar-editor">
      <button
        className="avatar-pick"
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        title="Сменить фото"
      >
        <Monogram username={profile.username} displayName={profile.displayName} avatarUrl={profile.avatarUrl} size="lg" />
        <span className="avatar-hint">{busy ? '…' : 'Фото'}</span>
      </button>

      <input
        ref={input}
        className="sr-only"
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={(e) => void upload(e.target.files?.[0] ?? null)}
      />

      {profile.avatarUrl && (
        <button className="post-delete" type="button" onClick={() => void remove()} disabled={busy}>
          Убрать фото
        </button>
      )}

      {error && <p className="error avatar-error">{error}</p>}
    </div>
  );
}

/** Обложка — в форме правки: загружается сразу, как и аватар, без «Сохранить». */
const MAX_COVER = 8 * 1024 * 1024;

function CoverPicker({ profile, onChanged }: { profile: User; onChanged: (user: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function run(action: () => Promise<{ user: User }>) {
    setBusy(true);
    setError(null);
    try {
      onChanged((await action()).user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сменить обложку');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  function pick(file: File | null) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('Обложка — только изображение');
    if (file.size > MAX_COVER) return setError('Изображение больше 8 МБ');
    void run(() => api.setCover(file));
  }

  return (
    <div className="field cover-field">
      <span>Обложка</span>
      <div className="cover-actions">
        <button className="btn ghost small" type="button" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Загружаю…' : profile.coverUrl ? 'Сменить обложку' : 'Выбрать обложку'}
        </button>
        {profile.coverUrl && (
          <button className="post-delete" type="button" disabled={busy} onClick={() => void run(() => api.removeCover())}>
            Убрать обложку
          </button>
        )}
      </div>
      <input
        ref={input}
        className="sr-only"
        type="file"
        aria-label="Файл обложки"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
      />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function ProfileForm({
  profile,
  onSaved,
  onCancel,
  onCover,
}: {
  profile: User;
  onSaved: (user: User) => void;
  onCancel: () => void;
  onCover: (user: User) => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio);
  // Три поля всегда: пустые — просто не сохраняются.
  const [links, setLinks] = useState<string[]>(() => [...(profile.links ?? []), '', '', ''].slice(0, LINKS_MAX));
  const [cover, setCover] = useState(profile);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const checked = normalizeLinks(links);
    if ('error' in checked) return setError(checked.error);
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateProfile({ displayName, bio, links: checked.links });
      onSaved(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      {error && <p className="error">{error}</p>}

      <label className="field">
        <span>Отображаемое имя</span>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} required />
      </label>

      <label className="field">
        <span>О себе</span>
        <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={200} rows={3} />
      </label>

      <fieldset className="field links-field">
        <legend>Ссылки — до трёх</legend>
        {links.map((value, i) => (
          <input
            key={i}
            type="text"
            inputMode="url"
            value={value}
            aria-label={`Ссылка ${i + 1}`}
            placeholder={i === 0 ? 't.me/вы или адрес сайта' : ''}
            maxLength={200}
            onChange={(e) => setLinks((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
          />
        ))}
      </fieldset>

      <CoverPicker
        profile={cover}
        onChanged={(updated) => {
          setCover(updated);
          onCover(updated);
        }}
      />

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Сохраняю…' : 'Сохранить'}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
          Отмена
        </button>
      </div>
    </form>
  );
}
