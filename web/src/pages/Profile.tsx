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
  const stream = usePostStream(username);

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
                <span>с {joinedOn(profile.createdAt)}</span>
              </p>
              {isMe && (
                <p style={{ marginTop: '0.875rem' }}>
                  <button className="btn ghost" type="button" onClick={() => setEditing(true)}>
                    Редактировать профиль
                  </button>
                </p>
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
