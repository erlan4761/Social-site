import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type Channel, type ChannelComment, type ChannelPost } from '../api';
import { Composer, MessageList, PaneHead, type BubbleItem, type MessageAction } from '../components/Chat';
import { useSession } from '../session';
import { plural } from '../time';
import { ChannelAvatar } from '../components/messenger/ListRows';

/** Обсуждение живее канала: ответ ждут, как в чате. */
const POLL_MS = 5_000;

/** Пересоздаётся на каждую публикацию (`key`). */
export function ChannelComments() {
  const { handle = '', postId = '' } = useParams();
  return <CommentsPane key={`${handle}/${postId}`} handle={handle.toLowerCase()} postId={Number.parseInt(postId, 10)} />;
}

function CommentsPane({ handle, postId }: { handle: string; postId: number }) {
  const { user } = useSession();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [post, setPost] = useState<ChannelPost | null>(null);
  const [comments, setComments] = useState<ChannelComment[]>([]);
  const [canComment, setCanComment] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const edits = useRef(0);

  const load = useCallback(async () => {
    const res = await api.channelComments(handle, postId);
    setChannel(res.channel);
    setPost(res.post);
    setCanComment(res.canComment);
    return res.comments;
  }, [handle, postId]);

  useEffect(() => {
    if (!Number.isSafeInteger(postId)) {
      setGone('Публикация не найдена');
      setLoading(false);
      return;
    }
    let cancelled = false;
    load()
      .then((list) => {
        if (!cancelled) setComments(list);
      })
      .catch((err) => {
        if (!cancelled) setGone(err instanceof ApiError ? err.message : 'Не удалось открыть комментарии');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, postId]);

  // Ветка приходит целиком — её и подставляем, так доходят и удаления.
  useEffect(() => {
    if (gone) return;
    let cancelled = false;
    const timer = setInterval(() => {
      const startedAt = edits.current;
      load()
        .then((list) => {
          if (!cancelled && edits.current === startedAt) setComments(list);
        })
        .catch((err) => {
          if (!cancelled && err instanceof ApiError && err.status === 404) setGone(err.message);
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load, gone]);

  async function send(text: string) {
    setError(null);
    try {
      const res = await api.addChannelComment(handle, postId, text);
      edits.current += 1;
      setComments((prev) => [...prev, res.comment]);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить комментарий');
      return false;
    }
  }

  async function act(action: MessageAction, item: BubbleItem) {
    // Первым в ленте стоит сама публикация — её id отрицательный, чтобы не
    // спутать с комментарием; с ней здесь можно только скопировать текст.
    const comment = comments.find((c) => c.id === item.id);
    try {
      if (action.type === 'copy') await navigator.clipboard.writeText(item.body);
      if (action.type === 'delete' && comment) {
        if (!window.confirm('Удалить комментарий?')) return;
        await api.deleteChannelComment(handle, postId, comment.id);
        edits.current += 1;
        setComments((prev) => prev.filter((c) => c.id !== comment.id));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    }
  }

  const back = { to: `/messages/ch/${handle}`, label: 'К каналу' };

  if (gone) {
    return (
      <div className="pane">
        <PaneHead avatar={null} title="Комментарии" subtitle="" back={back} />
        <div className="pane-empty">
          <p>
            <strong>{gone}.</strong> Возможно, публикацию удалили.
          </p>
          <Link to={back.to}>Вернуться в канал</Link>
        </div>
      </div>
    );
  }

  const owner = Boolean(channel?.iAmOwner);
  const items: BubbleItem[] = [];
  if (post) {
    items.push({
      id: -post.id,
      body: post.body,
      createdAt: post.createdAt,
      mine: false,
      editedAt: post.editedAt,
      forwardedFrom: null,
      replyTo: null,
      reactions: post.reactions,
      attachment: post.attachment,
      canEdit: false,
      canDelete: false,
      views: post.views,
    });
  }
  for (const c of comments) {
    const mine = c.author.id === user?.id;
    items.push({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      mine,
      author: c.author,
      editedAt: null,
      forwardedFrom: null,
      replyTo: null,
      reactions: [],
      attachment: null,
      canEdit: false,
      // Своё — автор, любое под своими публикациями — владелец канала.
      canDelete: mine || owner,
    });
  }

  const count = comments.length;

  return (
    <div className="pane">
      <PaneHead
        back={back}
        avatar={channel ? <ChannelAvatar title={channel.title} size="sm" /> : null}
        title="Комментарии"
        subtitle={channel ? `${channel.title}, ${count} ${plural(count, 'комментарий', 'комментария', 'комментариев')}` : ''}
      />

      <MessageList
        items={items}
        loading={loading}
        hasMore={false}
        loadingMore={false}
        onLoadOlder={() => undefined}
        onAction={(action, item) => void act(action, item)}
        actions={{ reply: false, react: false, forward: false }}
        empty={null}
      />

      {!loading && count === 0 && <p className="pane-hint">Комментариев пока нет — напишите первый.</p>}
      {error && <p className="error pane-error">{error}</p>}

      {canComment ? (
        <Composer placeholder="Комментарий" onSend={send} autoFocus />
      ) : (
        <div className="pane-blocked">
          <strong>Комментировать нельзя.</strong> Пока действует блокировка с автором канала, писать здесь не выйдет.
        </div>
      )}
    </div>
  );
}
