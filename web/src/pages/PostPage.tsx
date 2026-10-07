import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Post } from '../api';
import { PostRow } from '../components/PostRow';
import { useSession } from '../session';

/** Отдельная запись: сюда ведут события «отметил» и «ответил вам». */
export function PostPage() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const navigate = useNavigate();

  const [post, setPost] = useState<Post | null>(null);
  /** Ветка, если запись в ней, — по порядку; иначе null. */
  const [chain, setChain] = useState<Post[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMissing(false);
    setError(null);

    setChain(null);
    api
      .post(Number(id))
      .then(async (res) => {
        if (cancelled) return;
        setPost(res.post);
        if (res.post.thread) {
          const whole = await api.postThread(res.post.id).catch(() => null);
          if (!cancelled && whole) setChain(whole.posts);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // Сервер отвечает 404 и на мусорный id, и на запись автора,
        // с которым смотрящий в блокировке — для читателя это одно и то же.
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(err instanceof ApiError ? err.message : 'Не удалось открыть запись');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  async function remove(postId: number) {
    try {
      await api.deletePost(postId);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить запись');
    }
  }

  function patch(postId: number, changes: Partial<Post>) {
    setPost((prev) => (prev && prev.id === postId ? { ...prev, ...changes } : prev));
    setChain((prev) => prev?.map((x) => (x.id === postId ? { ...x, ...changes } : x)) ?? prev);
  }

  /** Продолжили ветку здесь же — новая запись встаёт в конец цепочки. */
  function appended(next: Post) {
    setChain((prev) => [...(prev ?? (post ? [post] : [])), next]);
  }

  return (
    <>
      <div className="events-top">
        <h1 className="page-title">Запись</h1>
        <Link className="btn ghost small" to="/">
          Вернуться в ленту
        </Link>
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="empty" style={{ marginLeft: 0 }}>Загружаю…</p>
      ) : missing ? (
        <p className="empty" style={{ marginLeft: 0 }}>
          <strong>Записи больше нет.</strong>
          Её удалили или она недоступна.
        </p>
      ) : (
        post &&
        (chain && chain.length > 1 ? (
          // Ветка целиком: открытая запись — с раскрытыми ответами, остальные — свёрнуты.
          <div className="rail thread-chain" aria-label={`Ветка из ${chain.length} записей`}>
            {chain.map((x) => (
              <div key={x.id} className={x.id === post.id ? 'thread-item current' : 'thread-item'}>
                <PostRow
                  post={x}
                  canDelete={x.author.id === user?.id}
                  openThread={x.id === post.id}
                  onDelete={(postId) => void remove(postId)}
                  onPatch={patch}
                  onCreated={appended}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="rail single">
            <PostRow
              post={post}
              canDelete={post.author.id === user?.id}
              openThread
              onDelete={(postId) => void remove(postId)}
              onPatch={patch}
              onCreated={appended}
            />
          </div>
        ))
      )}
    </>
  );
}
