import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type TagStat } from '../api';
import { tagPath } from '../hashtags';
import { plural } from '../time';

/**
 * Популярные теги за неделю — строкой ссылок. Пусто — блока нет вовсе:
 * заголовок над пустотой обещал бы то, чего нет. `skip` — тег текущей страницы.
 */
export function TrendingTags({ skip, title = 'Популярные теги' }: { skip?: string; title?: string }) {
  const [tags, setTags] = useState<TagStat[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .trendingTags()
      .then((res) => {
        if (!cancelled) setTags(res.tags);
      })
      .catch(() => {
        if (!cancelled) setTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = (tags ?? []).filter((t) => t.tag !== skip);
  if (shown.length === 0) return null;
  return (
    <section className="tag-cloud" aria-labelledby="tag-cloud-title">
      <h2 className="search-section-title" id="tag-cloud-title">
        {title}
      </h2>
      <ul className="tag-chips">
        {shown.map((t) => (
          <li key={t.tag}>
            <Link className="tag-chip" to={tagPath(t.tag)} title={`${t.count} ${plural(t.count, 'запись', 'записи', 'записей')} за неделю`}>
              #{t.label}
              <span className="tag-chip-count">{t.count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
