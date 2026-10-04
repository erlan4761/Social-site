import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, type AttachmentInput, type Channel, type ChannelPost, type PinnedPreview } from '../api';
import {
  Composer, ConversationSearch, MessageList, PaneNotice, useNotice, SelectionBar, messagesCount, plainText, useSelection, PaneHead, PinnedBar, editable, mergeLatest, previewText, revealOlder,
  type BubbleItem, type ComposerMode, type MessageAction,
} from '../components/Chat';
import { ForwardDialog, forwardingOf, type Forwarding } from '../components/ForwardDialog';
import { ThemePicker } from '../components/chat/ThemePicker';
import { useChatTheme } from '../chatThemes';
import { ScheduledBar } from '../components/Scheduled';
import { PollDialog } from '../components/PollDialog';
import { Icon } from '../components/Icon';
import { ShareLink, siteUrl } from '../components/ShareLink';
import { AutoDeleteNote, AutoDeleteSelect } from '../components/chat/AutoDelete';
import { plural } from '../time';
import { ChannelAvatar } from '../components/messenger/ListRows';
import { pollEvery, useLive, useLiveConnected } from '../live';
import type { MessengerContext } from './Messenger';

/** Канал — не переписка: публикации выходят редко, а «печатает…» здесь нет.
 *  Десять секунд — как у списка чатов. */
const POLL_MS = 10_000;
const TITLE_LIMIT = 60;
const DESCRIPTION_LIMIT = 255;

const subscribers = (n: number) => `${n} ${plural(n, 'подписчик', 'подписчика', 'подписчиков')}`;

/** Пересоздаётся на каждый канал (`key`), как и переписка. */
export function ChannelView() {
  const { handle = '' } = useParams();
  return <ChannelPane key={handle.toLowerCase()} handle={handle.toLowerCase()} />;
}

function ChannelPane({ handle }: { handle: string }) {
  const navigate = useNavigate();
  const { refreshList } = useOutletContext<MessengerContext>();

  const [channel, setChannel] = useState<Channel | null>(null);
  const [posts, setPosts] = useState<ChannelPost[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [mode, setMode] = useState<ComposerMode>(null);
  const [forwarding, setForwarding] = useState<Forwarding | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const [theme, setTheme] = useChatTheme('channel', (channel?.subscribed || channel?.iAmOwner ? handle : null));
  const [notice, notify] = useNotice();
  const selection = useSelection(posts.map((p) => p.id));
  const [pollOpen, setPollOpen] = useState(false);
  const [pins, setPins] = useState<PinnedPreview[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jump, setJump] = useState<{ id: number; seq: number } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Номер последнего своего изменения — см. Thread.tsx. */
  const edits = useRef(0);
  /** Растёт, когда здесь что-то отложили, — полоса «Отложено» перечитывает очередь. */
  const [scheduledVersion, setScheduledVersion] = useState(0);

  const markRead = useCallback(
    (c: Channel) => {
      if (!c.subscribed) return;
      void api.markChannelRead(c.handle).then(refreshList).catch(() => undefined);
    },
    [refreshList],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .channelPosts(handle)
      .then((res) => {
        if (cancelled) return;
        setChannel(res.channel);
        setPins(res.pins);
        setPosts(res.posts);
        setCursor(res.nextCursor);
        markRead(res.channel);
      })
      .catch((err) => {
        if (!cancelled) setGone(err instanceof ApiError ? err.message : 'Не удалось открыть канал');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [handle, markRead]);

  // Живой поток: толчок — перечитать сразу; с ним опрос — редкая страховка.
  const every = pollEvery(useLiveConnected(), POLL_MS);
  const pullRef = useRef<() => void>(() => undefined);
  useLive((e) => {
    if (e.t === 'ready' || (e.t === 'channel' && e.id === channel?.id)) pullRef.current();
  });

  useEffect(() => {
    if (gone) return;
    let cancelled = false;
    const pull = () => {
      const startedAt = edits.current;
      api
        .channelPosts(handle)
        .then((res) => {
          if (cancelled) return;
          setChannel(res.channel);
          setPins(res.pins);
          if (edits.current !== startedAt) return;
          setPosts((prev) => {
            const newest = prev.at(-1)?.id ?? 0;
            if (res.posts.some((p) => p.id > newest)) markRead(res.channel);
            return mergeLatest(prev, res.posts);
          });
        })
        .catch((err) => {
          if (!cancelled && err instanceof ApiError && err.status === 404) setGone(err.message);
        });
    };
    pullRef.current = pull;
    const timer = setInterval(pull, every);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [handle, gone, markRead, every]);

  async function loadOlder() {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.channelPosts(handle, cursor);
      setPosts((prev) => [...res.posts, ...prev]);
      setCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить более старые');
    } finally {
      setLoadingMore(false);
    }
  }

  async function reveal(id: number) {
    try {
      const res = await revealOlder(id, posts, cursor, async (c) => {
        const page = await api.channelPosts(handle, c);
        return { items: page.posts, nextCursor: page.nextCursor };
      });
      setPosts(res.list);
      setCursor(res.cursor);
      if (res.found) setJump({ id, seq: Date.now() });
      else setError('Публикация не найдена — возможно, её удалили');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось найти публикацию');
    }
  }

  // `?m=` — открыть канал сразу на публикации: так ведёт ссылка на неё.
  const [params, setParams] = useSearchParams();
  const wanted = Number.parseInt(params.get('m') ?? '', 10);
  useEffect(() => {
    if (loading || !Number.isSafeInteger(wanted)) return;
    setParams({}, { replace: true });
    void reveal(wanted);
    // reveal читает текущую ленту — эффект нужен ровно раз, когда она загрузилась.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, wanted]);

  /** Закрепить или открепить — ответ сервера приносит весь список закреплённых. */
  async function togglePin(id: number) {
    const res = pins.some((x) => x.id === id) ? await api.unpinPost(handle, id) : await api.pinPost(handle, id);
    setPins(res.pins);
  }

  function put(updated: ChannelPost) {
    edits.current += 1;
    setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  function append(post: ChannelPost) {
    edits.current += 1;
    setPosts((prev) => (prev.some((p) => p.id === post.id) ? prev : [...prev, post]));
    refreshList();
  }

  async function send(text: string) {
    setError(null);
    try {
      if (mode?.kind === 'edit') put((await api.editPost(handle, mode.id, text)).post);
      else append((await api.publish(handle, { body: text })).post);
      setMode(null);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось опубликовать');
      return false;
    }
  }

  async function sendAttachment(input: Omit<AttachmentInput, 'replyTo'>) {
    setError(null);
    try {
      append((await api.publish(handle, input)).post);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось опубликовать файл');
      return false;
    }
  }

  /** Удалить выбранные публикации — по одному запросу; не удалилось — остаётся. */
  async function deleteMany(ids: number[]) {
    if (!window.confirm(`Удалить ${messagesCount(ids.length)}? Исчезнет у всех подписчиков вместе с комментариями.`)) return false;
    setError(null);
    const done: number[] = [];
    try {
      for (const id of ids) {
        await api.deleteChannelPost(handle, id);
        done.push(id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить');
    }
    edits.current += 1;
    setPosts((prev) => prev.filter((p) => !done.includes(p.id)));
    if (mode && done.includes(mode.id)) setMode(null);
    refreshList();
    return done.length === ids.length;
  }

  async function act(action: MessageAction, item: BubbleItem) {
    const post = posts.find((p) => p.id === item.id);
    if (!post) return;
    setError(null);
    try {
      switch (action.type) {
        case 'edit':
          setMode({ kind: 'edit', id: post.id, body: post.body });
          break;
        case 'copy':
          await navigator.clipboard.writeText(plainText(post.body, 'show'));
          break;
        case 'link':
          await navigator.clipboard.writeText(siteUrl(`messages/ch/${handle}?m=${post.id}`));
          notify('Ссылка скопирована');
          break;
        case 'forward':
          setForwarding(forwardingOf('channel', item, previewText(post.body, post.attachment)));
          break;
        case 'pin':
          await togglePin(post.id);
          break;
        case 'react':
          put((await api.reactPost(handle, post.id, action.emoji)).post);
          break;
        case 'vote':
          if (post.poll) put({ ...post, poll: (await api.votePoll(post.poll.id, action.options)).poll });
          break;
        case 'closePoll':
          if (post.poll) put({ ...post, poll: (await api.closePoll(post.poll.id)).poll });
          break;
        case 'delete': {
          // У альбома удаляются все его снимки разом — как в переписке.
          const ids = action.ids ?? [post.id];
          const what = ids.length > 1 ? `альбом — ${ids.length} ${plural(ids.length, 'снимок', 'снимка', 'снимков')}` : 'публикацию';
          if (!window.confirm(`Удалить ${what}? Исчезнет у всех подписчиков вместе с комментариями.`)) return;
          for (const id of ids) await api.deleteChannelPost(handle, id);
          edits.current += 1;
          setPosts((prev) => prev.filter((p) => !ids.includes(p.id)));
          if (mode && ids.includes(mode.id)) setMode(null);
          refreshList();
          break;
        }
        case 'reply':
          break;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    }
  }

  async function toggleSubscription(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.subscribe(handle, on);
      setChannel(res.channel);
      refreshList();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    } finally {
      setBusy(false);
    }
  }

  if (gone) {
    return (
      <div className="pane">
        <PaneHead avatar={null} title="Канал недоступен" subtitle="" />
        <div className="pane-empty">
          <p>
            <strong>{gone}.</strong> Возможно, канал удалили или в адресе опечатка.
          </p>
          <Link to="/messages">Ко всем чатам</Link>
        </div>
      </div>
    );
  }

  const owner = Boolean(channel?.iAmOwner);
  const items: BubbleItem[] = posts.map((p) => ({
    id: p.id,
    body: p.body,
    createdAt: p.createdAt,
    // Публикации канала не делятся на «свои» и «чужие»: говорит канал, а
    // не человек, — все стоят слева, даже у владельца.
    mine: false,
    editedAt: p.editedAt,
    forwardedFrom: null,
    replyTo: null,
    reactions: p.reactions,
    attachment: p.attachment,
    expiresAt: p.expiresAt ?? null,
    albumId: p.albumId,
    poll: p.poll,
    canEdit: owner && !p.poll && editable(p.createdAt),
    canDelete: owner,
    views: p.views,
    commentsTo: `/messages/ch/${handle}/${p.id}`,
    commentCount: p.commentCount,
  }));

  return (
    <div className="pane" data-chat-theme={theme ?? undefined}>
      <PaneHead
        avatar={channel ? <ChannelAvatar title={channel.title} size="sm" /> : null}
        title={channel?.title ?? ''}
        subtitle={channel ? subscribers(channel.subscriberCount) : ''}
        actions={
          channel && (
            <>
            <button
              className={searchOpen ? 'icon-btn on' : 'icon-btn'}
              type="button"
              aria-expanded={searchOpen}
              aria-label="Поиск по переписке"
              title="Поиск по переписке"
              onClick={() => setSearchOpen((v) => !v)}
            >
              <Icon name="search" />
            </button>
              <button
                className={themeOpen ? 'icon-btn on' : 'icon-btn'}
                type="button"
                aria-expanded={themeOpen}
                aria-label="Оформление"
                title="Оформление"
                onClick={() => setThemeOpen((v) => !v)}
              >
                <Icon name="palette" />
              </button>
            <button
              className={infoOpen ? 'icon-btn on' : 'icon-btn'}
              type="button"
              aria-expanded={infoOpen}
              aria-label="О канале"
              title="О канале"
              onClick={() => setInfoOpen((v) => !v)}
            >
              <Icon name="more" />
            </button>
            </>
          )
        }
      />

      {themeOpen && (
        <div className="pane-panel">
          <ThemePicker value={theme} onChange={(next) => void setTheme(next)} />
          <p className="settings-note">Тема видна только вам — на всех ваших устройствах.</p>
        </div>
      )}

      {searchOpen && (
        <ConversationSearch
          onSearch={async (q) => (await api.searchChannel(handle, q)).results}
          onPick={(id) => {
            setSearchOpen(false);
            void reveal(id);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {pins.length > 0 && (
        <PinnedBar
          pins={pins}
          onOpen={(id) => void reveal(id)}
          onUnpin={owner ? (id) => void api.unpinPost(handle, id).then((r) => setPins(r.pins)).catch(() => undefined) : undefined}
        />
      )}

      {channel && infoOpen && (
        <ChannelInfo
          channel={channel}
          busy={busy}
          onSubscribe={(on) => void toggleSubscription(on)}
          onUpdated={(c) => {
            setChannel(c);
            refreshList();
          }}
          onDeleted={() => {
            refreshList();
            navigate('/messages');
          }}
        />
      )}

      <MessageList
        items={items}
        loading={loading}
        hasMore={cursor != null}
        loadingMore={loadingMore}
        onLoadOlder={() => void loadOlder()}
        onAction={(action, item) => void act(action, item)}
        selection={selection}
        actions={{ reply: false, pin: owner, link: true }}
        pinnedIds={pins.map((x) => x.id)}
        jump={jump}
        variant="channel"
        empty={
          owner ? (
            <>
              <strong>Канал создан.</strong>
              Опубликуйте первую запись — её увидят все подписчики.
            </>
          ) : (
            <>
              <strong>Публикаций пока нет.</strong>
              Подпишитесь, чтобы не пропустить первую.
            </>
          )
        }
      />

      {error && <p className="error pane-error">{error}</p>}
      <PaneNotice text={notice} />

      {selection.active ? (
        <SelectionBar
          selection={selection}
          items={items}
          from="channel"
          who={() => channel?.title ?? ''}
          onForward={setForwarding}
          onDelete={owner ? deleteMany : undefined}
        />
      ) : owner ? (
        <>
          {channel && <AutoDeleteNote seconds={channel.autoDelete} />}
          <ScheduledBar kind="channel" target={handle} version={scheduledVersion} onSent={refreshList} />
          <Composer
            key={`channel:${handle}`}
            draft={{ kind: 'channel', target: handle }}
            placeholder="Опубликовать…"
            onSchedule={async (text, at) => {
              await api.schedule('channel', handle, text, at.toISOString());
              setScheduledVersion((n) => n + 1);
            }}
            onSend={send}
            onSendAttachment={sendAttachment}
            onCreatePoll={() => setPollOpen(true)}
            mode={mode}
            onCancelMode={() => setMode(null)}
            albums
            autoFocus
          />
        </>
      ) : channel && !channel.subscribed ? (
        <div className="pane-subscribe">
          <button className="btn block" type="button" disabled={busy} onClick={() => void toggleSubscription(true)}>
            Подписаться
          </button>
        </div>
      ) : channel ? (
        <div className="pane-subscribe subscribed">
          <Icon name="check" size={18} />
          <span>Вы подписаны</span>
          <button className="act" type="button" disabled={busy} onClick={() => void toggleSubscription(false)}>
            Отписаться
          </button>
        </div>
      ) : null}

      {pollOpen && channel && (
        <PollDialog
          where={`В канале «${channel.title}»`}
          onSubmit={async (poll) => append((await api.publishPoll(handle, poll)).post)}
          onClose={() => setPollOpen(false)}
        />
      )}

      {forwarding && (
        <ForwardDialog
          groups={forwarding.groups}
          preview={forwarding.preview}
          onClose={() => setForwarding(null)}
        />
      )}
    </div>
  );
}

/* ─ Панель «О канале» ──────────────────────────────────────────────────── */

type InfoProps = {
  channel: Channel;
  busy: boolean;
  onSubscribe: (on: boolean) => void;
  onUpdated: (c: Channel) => void;
  onDeleted: () => void;
};

/** Описание, адрес и автор; владельцу — правка названия и описания и удаление. */
function ChannelInfo({ channel, busy, onSubscribe, onUpdated, onDeleted }: InfoProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(channel.title);
  const [description, setDescription] = useState(channel.description);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateChannel(channel.handle, { title: title.trim(), description: description.trim() });
      onUpdated(res.channel);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Удалить канал «${channel.title}»? Публикации и комментарии исчезнут у всех, вернуть их нельзя.`)) return;
    setSaving(true);
    try {
      await api.deleteChannel(channel.handle);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить канал');
      setSaving(false);
    }
  }

  return (
    <section className="pane-panel channel-info" aria-label="О канале">
      {error && <p className="error">{error}</p>}

      {editing ? (
        <form className="rename-form" onSubmit={save}>
          <label className="field">
            <span>Название</span>
            <input type="text" value={title} maxLength={TITLE_LIMIT} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Описание</span>
            <textarea rows={2} value={description} maxLength={DESCRIPTION_LIMIT} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="members-actions">
            <button className="btn small" type="submit" disabled={saving || !title.trim()}>
              Сохранить
            </button>
            <button className="btn ghost small" type="button" disabled={saving} onClick={() => setEditing(false)}>
              Отмена
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="channel-about">{channel.description || 'Описания нет.'}</p>
          <dl className="channel-facts">
            <div>
              <dt>Адрес</dt>
              <dd>@{channel.handle}</dd>
            </div>
            {channel.owner && (
              <div>
                <dt>Автор</dt>
                <dd>
                  <Link to={`/u/${channel.owner.username}`}>{channel.owner.displayName}</Link>
                </dd>
              </div>
            )}
            <div>
              <dt>Подписчики</dt>
              <dd>{channel.subscriberCount}</dd>
            </div>
          </dl>
          {/* Каналы открыты всем, кто вошёл: ссылка — просто адрес канала. */}
          <ShareLink path={`messages/ch/${channel.handle}`} label="Ссылка на канал" />
          <div className="members-actions">
            {channel.iAmOwner && (
              <AutoDeleteSelect
                value={channel.autoDelete}
                disabled={saving}
                onChange={(s) => {
                  setSaving(true);
                  api
                    .updateChannel(channel.handle, { autoDelete: s })
                    .then((res) => onUpdated(res.channel))
                    .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось сохранить'))
                    .finally(() => setSaving(false));
                }}
              />
            )}
            {channel.iAmOwner ? (
              <>
                <button className="act" type="button" onClick={() => setEditing(true)}>
                  Изменить название и описание
                </button>
                <button className="act act-danger" type="button" disabled={saving} onClick={() => void remove()}>
                  Удалить канал
                </button>
              </>
            ) : channel.subscribed ? (
              <button className="act act-danger" type="button" disabled={busy} onClick={() => onSubscribe(false)}>
                Отписаться
              </button>
            ) : (
              <button className="act" type="button" disabled={busy} onClick={() => onSubscribe(true)}>
                Подписаться
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
