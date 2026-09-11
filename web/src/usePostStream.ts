import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Post } from './api';

type StreamSource = {
  author?: string;
  feed?: 'following';
  /** `YYYY` или `YYYY-MM` — месяц архива, выбранный в профиле. */
  period?: string;
  /** Другой источник записей вместо `/posts`. Пока он один — свои закладки. */
  source?: 'bookmarks';
  /** Смена числа перезагружает ленту тем же запросом. Нужна там, где выдача
   *  меняется не от нашей навигации, а от действия: после блокировки автора
   *  сервер отдаёт уже другой список, а адрес страницы прежний. */
  reloadKey?: number;
};

/** Loads a paginated stream of posts — the whole feed, one author's, the viewer's subscriptions, or their bookmarks. */
export function usePostStream({ author, feed, period, source, reloadKey }: StreamSource = {}) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<number | null>(null);

  /**
   * Курсор здесь намеренно непрозрачный: в лентах это id последней записи, в
   * закладках — id закладки. Хук его не толкует, а возвращает серверу тем же,
   * чем получил, поэтому оба источника листаются одним кодом.
   */
  const fetchPage = useCallback(
    (cursor?: number | null) => (source === 'bookmarks'
      ? api.bookmarks(cursor)
      : api.posts({ author, feed, period, cursor })),
    [author, feed, period, source],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchPage()
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
  }, [fetchPage, reloadKey]);

  const loadMore = useCallback(async () => {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setPosts((prev) => [...prev, ...page.posts]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить ещё');
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, cursor, loadingMore]);

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
