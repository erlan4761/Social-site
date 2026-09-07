import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Post } from './api';

/** Loads a paginated stream of posts — the whole feed, or one author's. */
export function usePostStream(author?: string) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .posts({ author })
      .then((page) => {
        if (cancelled) return;
        setPosts(page.posts);
        setCursor(page.nextCursor);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить ленту');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [author]);

  const loadMore = useCallback(async () => {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.posts({ author, cursor });
      setPosts((prev) => [...prev, ...page.posts]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить ещё');
    } finally {
      setLoadingMore(false);
    }
  }, [author, cursor, loadingMore]);

  const prepend = useCallback((post: Post) => {
    setPosts((prev) => [post, ...prev]);
    setFreshId(post.id);
  }, []);

  /** Update one post in place — like state, comment count. */
  const patch = useCallback((id: number, changes: Partial<Post>) => {
    setPosts((prev) => prev.map((p) => (p.id === id ? { ...p, ...changes } : p)));
  }, []);

  /** Optimistic delete. Returns whether the server actually accepted it. */
  const remove = useCallback(async (id: number) => {
    const snapshot = posts;
    setPosts((prev) => prev.filter((p) => p.id !== id));
    try {
      await api.deletePost(id);
      return true;
    } catch (err) {
      setPosts(snapshot); // put it back; the delete did not happen
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить пост');
      return false;
    }
  }, [posts]);

  return {
    posts, loading, loadingMore, error,
    hasMore: cursor != null,
    loadMore, prepend, patch, remove, freshId,
  };
}
