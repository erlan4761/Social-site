import { Link } from 'react-router-dom';
import type { Post } from '../api';
import { fullDate, timeAgo } from '../time';
import { Monogram } from './Monogram';

type Props = {
  post: Post;
  fresh?: boolean;
  canDelete: boolean;
  onDelete: (id: number) => void;
};

export function PostRow({ post, fresh, canDelete, onDelete }: Props) {
  const { author } = post;
  const profile = `/u/${author.username}`;

  return (
    <article className={fresh ? 'rail-row fresh' : 'rail-row'}>
      <Link className="avatar-link" to={profile} aria-label={`Профиль ${author.displayName}`}>
        <Monogram username={author.username} displayName={author.displayName} />
      </Link>

      <div>
        <header className="post-head">
          <Link className="post-name" to={profile}>
            {author.displayName}
          </Link>
          <span className="post-handle">@{author.username}</span>
          <time className="post-time" dateTime={post.createdAt} title={fullDate(post.createdAt)}>
            {timeAgo(post.createdAt)}
          </time>
        </header>

        <p className="post-body">{post.body}</p>

        {canDelete && (
          <div className="post-actions">
            <button className="post-delete" type="button" onClick={() => onDelete(post.id)}>
              Удалить
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
