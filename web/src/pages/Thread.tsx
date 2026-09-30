import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, ApiError, type AttachmentInput, type Message, type Person, type PinnedPreview, type SendOptions } from '../api';
import {
  Composer, ConversationSearch, MessageList, SelectionBar, messagesCount, plainText, useSelection, PaneHead, PinnedBar, PresenceAvatar, TypingDots, revealOlder, editable, mergeLatest, previewText,
  type BubbleItem, type ComposerMode, type MessageAction,
} from '../components/Chat';
import { ForwardDialog, forwardingOf, type Forwarding } from '../components/ForwardDialog';
import { ScheduledBar } from '../components/Scheduled';
import { Icon } from '../components/Icon';
import { SavedAvatar } from '../components/Monogram';
import { useSession } from '../session';
import { useCalls } from '../calls';
import { AutoDeleteNote, AutoDeleteSelect } from '../components/chat/AutoDelete';
import { pollEvery, useLive, useLiveConnected } from '../live';
import { isOnline, lastSeenLabel, plural } from '../time';
import { SAVED_TITLE } from '../components/messenger/rows';
import type { MessengerContext } from './Messenger';

/** Открытая переписка — это ожидание ответа, и «печатает…» живёт шесть
 *  секунд: опрос чаще, чем у списка. */
const POLL_MS = 3_000;

/** Страница живёт внутри мессенджера и пересоздаётся на каждого собеседника
 *  (`key`): состояние одной переписки не должно протекать в другую. */
export function Thread() {
  const { username = '' } = useParams();
  return <ThreadView key={username.toLowerCase()} username={username} />;
}

function ThreadView({ username }: { username: string }) {
  const { user, setUnreadTotal, refreshBadges } = useSession();
  const { refreshList } = useOutletContext<MessengerContext>();
  const calls = useCalls();

  const [other, setOther] = useState<Person | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Блокировка в любую сторону: история остаётся, поле ввода — нет.
  const [blocked, setBlocked] = useState(false);
  const [typing, setTyping] = useState(false);
  const [mode, setMode] = useState<ComposerMode>(null);
  const [forwarding, setForwarding] = useState<Forwarding | null>(null);
  const selection = useSelection(messages.map((m) => m.id));
  const [pins, setPins] = useState<PinnedPreview[]>([]);
  const [autoDelete, setAutoDelete] = useState(0);
  const [timerOpen, setTimerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jump, setJump] = useState<{ id: number; seq: number } | null>(null);

  /** Номер последнего своего изменения. Ответ опроса, ушедшего раньше него,
   *  не должен откатить только что поставленную реакцию или правку. */
  const edits = useRef(0);
  /** Растёт, когда здесь что-то отложили, — полоса «Отложено» перечитывает очередь. */
  const [scheduledVersion, setScheduledVersion] = useState(0);
  /** «Избранное» — переписка с самим собой: заметки, ссылки, пересланное. */
  const saved = user != null && user.username === username.toLowerCase();

  const markRead = useCallback(() => {
    api
      .markRead(username)
      .then((res) => {
        setUnreadTotal(res.unreadTotal);
        // Прочтение гасит и событие о переписке, и жирную строку в списке.
        refreshBadges();
        refreshList();
      })
      .catch(() => undefined);
  }, [username, setUnreadTotal, refreshBadges, refreshList]);

  useEffect(() => {
    let cancelled = false;
    api
      .thread(username)
      .then((res) => {
        if (cancelled) return;
        setOther(res.user);
        setMessages(res.messages);
        setCursor(res.nextCursor);
        setBlocked(Boolean(res.blocked));
        setTyping(res.typing);
        setPins(res.pins);
        setAutoDelete(res.autoDelete ?? 0);
        // Всегда, а не только при непрочитанных: вместе с перепиской гаснет и
        // событие о ней в «Событиях».
        markRead();
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось открыть переписку');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [username, markRead]);

  // Перечитывание переписки: вместе с новыми сообщениями приходят правки,
  // реакции, удаления, галочки, «в сети» и «печатает…». Толчок живого потока —
  // перечитать сразу; пока поток жив, опрос по таймеру — редкая страховка.
  const every = pollEvery(useLiveConnected(), POLL_MS);
  const pullRef = useRef<() => void>(() => undefined);
  const typingTimer = useRef<number | undefined>(undefined);
  useLive((e) => {
    if (e.t === 'ready' || (e.t === 'dm' && other != null && e.with === other.id)) pullRef.current();
  });

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      const startedAt = edits.current;
      api
        .thread(username)
        .then((res) => {
          if (cancelled) return;
          setOther(res.user);
          setBlocked(Boolean(res.blocked));
          setTyping(res.typing);
          window.clearTimeout(typingTimer.current);
          if (res.typing) typingTimer.current = window.setTimeout(() => pullRef.current(), 6_500);
          setPins(res.pins);
          if (edits.current !== startedAt) return;
          setMessages((prev) => {
            const newest = prev.at(-1)?.id ?? 0;
            if (res.messages.some((m) => m.id > newest && m.toId === user?.id)) markRead();
            return mergeLatest(prev, res.messages);
          });
        })
        .catch(() => undefined);
    };
    pullRef.current = pull;
    const timer = setInterval(pull, every);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [username, user?.id, markRead, every]);

  /** Показать сообщение: догрузить ленту до него и прокрутить. */
  async function reveal(id: number) {
    try {
      const res = await revealOlder(id, messages, cursor, async (c) => {
        const page = await api.thread(username, c);
        return { items: page.messages, nextCursor: page.nextCursor };
      });
      setMessages(res.list);
      setCursor(res.cursor);
      if (res.found) setJump({ id, seq: Date.now() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось найти сообщение');
    }
  }

  /** Закрепить или открепить — ответ сервера приносит весь список закреплённых. */
  async function togglePin(id: number) {
    const res = pins.some((x) => x.id === id) ? await api.unpinMessage(username, id) : await api.pinMessage(username, id);
    setPins(res.pins);
  }

  async function loadOlder() {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.thread(username, cursor);
      setMessages((prev) => [...res.messages, ...prev]);
      setCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить более старые');
    } finally {
      setLoadingMore(false);
    }
  }

  /** Заменить одно сообщение ответом сервера — после правки или реакции. */
  function put(updated: Message) {
    edits.current += 1;
    setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  }

  async function send(text: string, opts?: SendOptions) {
    setError(null);
    try {
      if (mode?.kind === 'edit') {
        const res = await api.editMessage(username, mode.id, text);
        put(res.message);
      } else {
        const res = await api.sendMessage(username, text, mode?.kind === 'reply' ? mode.id : null, opts);
        edits.current += 1;
        setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
        refreshList();
      }
      setMode(null);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить');
      return false;
    }
  }

  /** Файл с подписью или голосовое. Ответом может быть и вложение. */
  async function sendAttachment(input: Omit<AttachmentInput, 'replyTo'>) {
    setError(null);
    try {
      const res = await api.sendAttachment(username, { ...input, replyTo: mode?.kind === 'reply' ? mode.id : null });
      edits.current += 1;
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      setMode(null);
      refreshList();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить файл');
      return false;
    }
  }

  async function act(action: MessageAction, item: BubbleItem) {
    const msg = messages.find((m) => m.id === item.id);
    if (!msg || !other) return;
    setError(null);

    try {
      switch (action.type) {
        case 'reply':
          setMode({
            kind: 'reply',
            id: msg.id,
            who: msg.fromId === user?.id ? (user?.displayName ?? '') : other.displayName,
            body: previewText(msg.body, msg.attachment, msg.sticker),
          });
          break;
        case 'edit':
          setMode({ kind: 'edit', id: msg.id, body: msg.body });
          break;
        case 'copy':
          await navigator.clipboard.writeText(plainText(msg.body, 'show'));
          break;
        case 'forward':
          setForwarding(forwardingOf('dm', item, previewText(msg.body, msg.attachment, msg.sticker)));
          break;
        case 'pin':
          await togglePin(msg.id);
          break;
        case 'react':
          put((await api.reactMessage(username, msg.id, action.emoji)).message);
          break;
        case 'delete': {
          const ids = action.ids ?? [msg.id];
          const what = ids.length > 1 ? `альбом — ${ids.length} ${plural(ids.length, 'снимок', 'снимка', 'снимков')}` : 'сообщение';
          if (!window.confirm(saved ? `Удалить ${what}?` : `Удалить ${what}? Исчезнет и у собеседника.`)) return;
          for (const id of ids) await api.deleteMessage(username, id);
          edits.current += 1;
          setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
          if (mode && ids.includes(mode.id)) setMode(null);
          refreshList();
          break;
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    }
  }

  /** Удалить выбранные — по одному запросу на сообщение; не удалилось — остаётся. */
  async function deleteMany(ids: number[]) {
    const what = messagesCount(ids.length);
    if (!window.confirm(saved ? `Удалить ${what}?` : `Удалить ${what}? Исчезнет и у собеседника.`)) return false;
    setError(null);
    const done: number[] = [];
    try {
      for (const id of ids) {
        await api.deleteMessage(username, id);
        done.push(id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить');
    }
    edits.current += 1;
    setMessages((prev) => prev.filter((m) => !done.includes(m.id)));
    if (mode && done.includes(mode.id)) setMode(null);
    refreshList();
    return done.length === ids.length;
  }

  /** Стрелка вверх в пустом поле — правка последнего своего, которое ещё можно править. */
  function editLast() {
    const last = [...messages].reverse().find((m) => m.fromId === user?.id && !m.forwardedFrom && editable(m.createdAt));
    if (last) setMode({ kind: 'edit', id: last.id, body: last.body });
  }

  if (error && !other) {
    return (
      <div className="pane">
        <div className="pane-empty">
          <p className="error">{error}</p>
        </div>
      </div>
    );
  }

  const items: BubbleItem[] = messages.map((m) => {
    const mine = m.fromId === user?.id;
    return {
      id: m.id,
      body: m.body,
      createdAt: m.createdAt,
      mine,
      status: mine && !saved ? (m.readAt ? 'read' : 'sent') : undefined,
      editedAt: m.editedAt,
      forwardedFrom: m.forwardedFrom,
      replyTo: m.replyTo,
      reactions: m.reactions,
      attachment: m.attachment,
      sticker: m.sticker,
      albumId: m.albumId,
      expiresAt: m.expiresAt ?? null,
      canEdit: mine && !m.forwardedFrom && !m.sticker && !m.call && editable(m.createdAt),
      call: m.call ?? null,
      canDelete: mine,
    };
  });

  const online = !saved && !blocked && isOnline(other?.lastSeenAt);

  return (
    <div className="pane">
      {other && saved ? (
        <PaneHead
          avatar={<SavedAvatar size="sm" />}
          title={SAVED_TITLE}
          subtitle="заметки, ссылки и пересланное — только для вас"
          actions={
            <button
              className={searchOpen ? 'icon-btn on' : 'icon-btn'}
              type="button"
              aria-expanded={searchOpen}
              aria-label="Поиск по «Избранному»"
              title="Поиск по «Избранному»"
              onClick={() => setSearchOpen((v) => !v)}
            >
              <Icon name="search" />
            </button>
          }
        />
      ) : other ? (
        <PaneHead
          to={`/u/${other.username}`}
          avatar={<PresenceAvatar person={blocked ? { ...other, lastSeenAt: null } : other} size="sm" />}
          title={other.displayName}
          // При блокировке — не «был(а) давно»: это выдавало бы, что время
          // визита скрыто. Показываем логин, как у любого другого.
          subtitle={
            blocked ? (
              `@${other.username}`
            ) : typing ? (
              <>
                печатает
                <TypingDots />
              </>
            ) : (
              lastSeenLabel(other.lastSeenAt, other.seenRecently)
            )
          }
          live={online || typing}
          actions={
            <>
              {/* Звонок — как в Телеграме: голосом или с видео. При блокировке — нет. */}
              {!blocked && (
                <>
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label="Позвонить"
                    title="Позвонить"
                    disabled={calls.busy}
                    onClick={() => calls.startCall(other, false)}
                  >
                    <Icon name="phone" />
                  </button>
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label="Видеозвонок"
                    title="Видеозвонок"
                    disabled={calls.busy}
                    onClick={() => calls.startCall(other, true)}
                  >
                    <Icon name="video" />
                  </button>
                </>
              )}
              {!blocked && (
                <button
                  className={timerOpen || autoDelete ? 'icon-btn on' : 'icon-btn'}
                  type="button"
                  aria-expanded={timerOpen}
                  aria-label="Автоудаление"
                  title="Автоудаление"
                  onClick={() => setTimerOpen((v) => !v)}
                >
                  <Icon name="clock" />
                </button>
              )}
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
            </>
          }
        />
      ) : (
        <header className="pane-head" />
      )}

      {searchOpen && (
        <ConversationSearch
          onSearch={async (q) => (await api.searchThread(username, q)).results}
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
          onUnpin={blocked ? undefined : (id) => void api.unpinMessage(username, id).then((r) => setPins(r.pins)).catch(() => undefined)}
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
        actions={{ pin: !blocked }}
        pinnedIds={pins.map((x) => x.id)}
        jump={jump}
        readOnly={blocked}
        empty={
          saved ? (
            <>
              <strong>Это ваше «Избранное».</strong>
              Пишите сюда заметки, сохраняйте ссылки и файлы, пересылайте сообщения из любых чатов — видите их
              только вы.
            </>
          ) : (
            <>
              <strong>Здесь пока пусто.</strong>
              Напишите первое сообщение.
            </>
          )
        }
      />

      {error && other && <p className="error pane-error">{error}</p>}

      {/* Текст одинаков в обе стороны: по нему нельзя понять, кто кого
          заблокировал — ровно как и в ответе сервера. */}
      {selection.active ? (
        <SelectionBar
          selection={selection}
          items={items}
          from="dm"
          who={(m) => (m.mine ? (user?.displayName ?? '') : (other?.displayName ?? ''))}
          onForward={setForwarding}
          onDelete={deleteMany}
        />
      ) : blocked ? (
        <div className="pane-blocked">
          <strong>Переписка недоступна.</strong> Пока действует блокировка, написать сюда нельзя. История
          остаётся на месте.
        </div>
      ) : (
        <>
          {timerOpen && (
            <div className="pane-panel">
              <AutoDeleteSelect
                value={autoDelete}
                onChange={(s) => {
                  setAutoDelete(s);
                  void api.setDmAutoDelete(username, s).catch((err) => setError(err instanceof ApiError ? err.message : 'Не получилось'));
                }}
              />
              <p className="settings-note">Таймер общий: собеседник видит его и может сменить. Отправленное раньше не трогается.</p>
            </div>
          )}
          <AutoDeleteNote seconds={autoDelete} />
          <ScheduledBar kind="dm" target={username} version={scheduledVersion} onSent={refreshList} />
          <Composer
            key={`dm:${username}`}
            draft={{ kind: 'dm', target: username }}
            albums
            silent={!saved}
            placeholder={saved ? 'Заметка для себя' : 'Сообщение'}
            onSchedule={async (text, at) => {
              await api.schedule('dm', username, text, at.toISOString());
              setScheduledVersion((n) => n + 1);
            }}
            onSend={send}
            onSendAttachment={sendAttachment}
            onSendSticker={async (sticker) => {
              setError(null);
              try {
                const res = await api.sendSticker(username, sticker);
                edits.current += 1;
                setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
                refreshList();
                return true;
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Не удалось отправить стикер');
                return false;
              }
            }}
            mode={mode}
            onCancelMode={() => setMode(null)}
            onEditLast={editLast}
            onTyping={saved ? undefined : () => void api.typing(username).catch(() => undefined)}
            autoFocus
          />
        </>
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
