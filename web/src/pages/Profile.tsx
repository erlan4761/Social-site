import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type BlockedUser, type User } from '../api';
import { Monogram } from '../components/Monogram';
import { PostRow } from '../components/PostRow';
import { ReportDialog } from '../components/ReportDialog';
import { useSession } from '../session';
import { joinedOn, plural } from '../time';
import { usePostStream } from '../usePostStream';

export function Profile() {
  const { username = '' } = useParams();
  const { user: me, setUser, refreshBadges } = useSession();
  const [profile, setProfile] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  // Блокировка меняет выдачу сервера, а адрес страницы остаётся прежним —
  // ленту профиля приходится просить заново.
  const [reloadKey, setReloadKey] = useState(0);
  const stream = usePostStream({ author: username, reloadKey });

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setError(null);
    setEditing(false);

    api
      .profile(username)
      .then((res) => !cancelled && setProfile(res.user))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Ошибка загрузки'));

    return () => {
      cancelled = true;
    };
  }, [username]);

  if (error) return <p className="error">{error}</p>;
  if (!profile) return <p className="empty" style={{ marginLeft: 0 }}>Загружаю…</p>;

  const isMe = me?.id === profile.id;
  const count = profile.postCount ?? 0;
  const followers = profile.followerCount ?? 0;
  const following = profile.followingCount ?? 0;

  async function toggleFollow() {
    if (!profile || followBusy) return;
    const next = !profile.followedByMe;

    setFollowBusy(true);
    setFollowError(null);
    // Optimistic: the button answers the click, then the server confirms.
    setProfile((p) => (p ? { ...p, followedByMe: next, followerCount: (p.followerCount ?? 0) + (next ? 1 : -1) } : p));

    try {
      const res = await api.setFollow(profile.username, next);
      setProfile((p) => (p ? { ...p, followedByMe: res.followedByMe, followerCount: res.followerCount } : p));
    } catch (err) {
      setProfile((p) => (p ? { ...p, followedByMe: !next, followerCount: followers } : p));
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
                setProfile({ ...updated, postCount: count });
                setUser(updated);
                setEditing(false);
              }}
            />
          ) : (
            <>
              <h1 className="profile-name">{profile.displayName}</h1>
              <p className="profile-handle">@{profile.username}</p>
              {profile.bio && <p className="profile-bio">{profile.bio}</p>}
              <p className="profile-meta">
                <span>
                  {count} {plural(count, 'пост', 'поста', 'постов')}
                </span>
                <span>
                  {followers} {plural(followers, 'подписчик', 'подписчика', 'подписчиков')}
                </span>
                <span>
                  {following} {plural(following, 'подписка', 'подписки', 'подписок')}
                </span>
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
                  <button className="btn ghost" type="button" onClick={() => setEditing(true)}>
                    Редактировать профиль
                  </button>
                ) : (
                  <>
                    {!profile.blockedByMe && !profile.blocksMe && (
                      <>
                        <button
                          className={profile.followedByMe ? 'btn ghost' : 'btn'}
                          type="button"
                          onClick={() => void toggleFollow()}
                          disabled={followBusy}
                        >
                          {profile.followedByMe ? 'Отписаться' : 'Подписаться'}
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

      <div className="rail">
        {stream.error && <p className="error">{stream.error}</p>}

        {stream.loading ? (
          <p className="empty">Загружаю…</p>
        ) : stream.posts.length === 0 ? (
          // Пустая лента у заблокированного — не «постов нет», а «их не видно»:
          // подменять причину значит врать человеку о его же действии.
          profile.blockedByMe || profile.blocksMe ? (
            <p className="empty">
              <strong>Записи скрыты.</strong>
              Они появятся снова, если блокировка будет снята.
            </p>
          ) : (
            <p className="empty">
              <strong>{isMe ? 'Вы ещё ничего не написали.' : 'Постов пока нет.'}</strong>
              {isMe ? 'Первая запись появится здесь.' : 'Загляните позже.'}
            </p>
          )
        ) : (
          stream.posts.map((post) => (
            <PostRow
              key={post.id}
              post={post}
              canDelete={isMe}
              onPatch={stream.patch}
              onDelete={async (id) => {
                if (!(await stream.remove(id))) return;
                setProfile((p) => (p ? { ...p, postCount: Math.max(0, (p.postCount ?? 1) - 1) } : p));
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

function ProfileForm({
  profile,
  onSaved,
  onCancel,
}: {
  profile: User;
  onSaved: (user: User) => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateProfile({ displayName, bio });
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
