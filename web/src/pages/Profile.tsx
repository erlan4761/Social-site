import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, type User } from '../api';
import { Monogram } from '../components/Monogram';
import { PostRow } from '../components/PostRow';
import { useSession } from '../session';
import { joinedOn, plural } from '../time';
import { usePostStream } from '../usePostStream';

export function Profile() {
  const { username = '' } = useParams();
  const { user: me, setUser } = useSession();
  const [profile, setProfile] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const stream = usePostStream({ author: username });

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

  return (
    <>
      <div className="profile-head">
        <Monogram username={profile.username} displayName={profile.displayName} size="lg" />

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

              <p style={{ marginTop: '0.875rem' }}>
                {isMe ? (
                  <button className="btn ghost" type="button" onClick={() => setEditing(true)}>
                    Редактировать профиль
                  </button>
                ) : (
                  <button
                    className={profile.followedByMe ? 'btn ghost' : 'btn'}
                    type="button"
                    onClick={() => void toggleFollow()}
                    disabled={followBusy}
                  >
                    {profile.followedByMe ? 'Отписаться' : 'Подписаться'}
                  </button>
                )}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="rail">
        {stream.error && <p className="error">{stream.error}</p>}

        {stream.loading ? (
          <p className="empty">Загружаю…</p>
        ) : stream.posts.length === 0 ? (
          <p className="empty">
            <strong>{isMe ? 'Вы ещё ничего не написали.' : 'Постов пока нет.'}</strong>
            {isMe ? 'Первая запись появится здесь.' : 'Загляните позже.'}
          </p>
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
