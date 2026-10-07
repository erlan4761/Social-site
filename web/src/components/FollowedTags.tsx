import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { tagPath } from '../hashtags';

/**
 * Над вкладкой «Подписки» — теги, за которыми человек следит: их записи тоже
 * здесь, и без этой строки непонятно, откуда в подписках чужой человек.
 * Ни одного — строки нет.
 */
export function FollowedTags() {
  const [tags, setTags] = useState<{ tag: string; label: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .followedTags()
      .then((res) => {
        if (!cancelled) setTags(res.tags);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (tags.length === 0) return null;
  return (
    <p className="followed-tags">
      <span>Здесь и записи с тегами:</span>
      {tags.map((t) => (
        <Link key={t.tag} className="tag-link" to={tagPath(t.tag)}>
          #{t.label}
        </Link>
      ))}
    </p>
  );
}

/** «Следить за тегом» — на странице тега. Записи с ним приходят во вкладку «Подписки». */
export function TagFollowButton({ tag, initial }: { tag: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setOn(initial), [initial]);

  async function toggle() {
    const next = !on;
    setBusy(true);
    setError(null);
    setOn(next);
    try {
      setOn((await api.setTagFollow(tag, next)).followedByMe);
    } catch (err) {
      setOn(!next);
      setError(err instanceof Error ? err.message : 'Не получилось');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className={on ? 'btn ghost small' : 'btn small'}
        type="button"
        disabled={busy}
        aria-pressed={on}
        title={on ? 'Записи с этим тегом приходят во вкладку «Подписки»' : 'Записи с этим тегом будут во вкладке «Подписки»'}
        onClick={() => void toggle()}
      >
        {on ? 'Вы следите' : 'Следить за тегом'}
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}
