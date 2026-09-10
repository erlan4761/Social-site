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
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMissing(false);
    setError(null);

    api
      .post(Number(id))
      .then((res) => !cancelled && setPost(res.post))
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

  function patch(_postId: number, changes: Partial<Post>) {
    setPost((prev) => (prev ? { ...prev, ...changes } : prev));
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
        post && (
          <div className="rail single">
            <PostRow
              post={post}
              canDelete={post.author.id === user?.id}
              openThread
              onDelete={(postId) => void remove(postId)}
              onPatch={patch}
            />
          </div>
        )
      )}
    </>
  );
}
