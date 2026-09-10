import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Chat, type ChatMessage } from '../api';
import { MemberSearch } from '../components/MemberSearch';
import { Monogram } from '../components/Monogram';
import { useSession } from '../session';
import { fullDate, plural, timeAgo } from '../time';

const LIMIT = 1000;
const TITLE_LIMIT = 60;
/** Потолок сервера: 21-й участник получает 400, и звать его незачем. */
const MAX_MEMBERS = 20;
/** Открытый чат — это ожидание ответа, тот же шаг, что в личной переписке. */
const POLL_MS = 5_000;

export function ChatThread() {
  const { id: idParam = '' } = useParams();
  const chatId = Number.parseInt(idParam, 10);
  const valid = Number.isSafeInteger(chatId) && chatId > 0;

  const navigate = useNavigate();
  const { user, refreshBadges } = useSession();

  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Сообщение об ошибке отправки или подгрузки — страница при этом остаётся.
  const [error, setError] = useState<string | null>(null);
  // Чат недоступен: удалён, вас в нём нет или номера такого не было. Сервер
  // намеренно не различает эти случаи — для страницы это одно состояние.
  const [gone, setGone] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const [membersOpen, setMembersOpen] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');

  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const markRead = useCallback(() => {
    if (!valid) return;
    api
      .markChatRead(chatId)
      .then(() => refreshBadges())
      .catch(() => undefined);
  }, [chatId, valid, refreshBadges]);

  // Первая загрузка: показать переписку и погасить непрочитанное.
  useEffect(() => {
    if (!valid) {
      setLoading(false);
      setGone('Чат не найден');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setGone(null);
    setMembersOpen(false);
    setRenaming(false);
    stick.current = true;

    api
      .chatMessages(chatId)
      .then((res) => {
        if (cancelled) return;
        setChat(res.chat);
        setMessages(res.messages);
        setCursor(res.nextCursor);
        markRead();
      })
      .catch((err) => {
        if (cancelled) return;
        setGone(err instanceof ApiError ? err.message : 'Не удалось открыть чат');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chatId, valid, markRead]);

  // Опрос: без WebSocket реплика соседа иначе не появится сама. Заодно
  // подтягивается состав и название — их мог поменять другой участник.
  useEffect(() => {
    if (!valid || gone) return;
    let cancelled = false;

    const timer = setInterval(() => {
      api
        .chatMessages(chatId)
        .then((res) => {
          if (cancelled) return;
          setChat(res.chat);
          setMessages((prev) => {
            const newest = prev.at(-1)?.id ?? 0;
            const fresh = res.messages.filter((m) => m.id > newest);
            if (fresh.length === 0) return prev;
            if (fresh.some((m) => m.author.id !== user?.id)) markRead();
            return [...prev, ...fresh];
          });
        })
        .catch((err) => {
          // Пока страница была открыта, чат могли удалить или вас из него
          // убрать. Молча продолжать опрос бессмысленно.
          if (!cancelled && err instanceof ApiError && err.status === 404) setGone(err.message);
        });
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [chatId, valid, gone, user?.id, markRead]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  async function loadOlder() {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    stick.current = false;
    try {
      const res = await api.chatMessages(chatId, cursor);
      setMessages((prev) => [...res.messages, ...prev]);
      setCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить более старые');
    } finally {
      setLoadingMore(false);
    }
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > LIMIT || sending) return;

    setSending(true);
    setError(null);
    try {
      const res = await api.sendChatMessage(chatId, trimmed);
      stick.current = true;
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      setText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить');
    } finally {
      setSending(false);
    }
  }

  /** Уйти со страницы: после выхода и удаления чат отвечает 404, перечитывать
   *  его незачем — сразу возвращаемся к списку. */
  function leavePage() {
    refreshBadges();
    navigate('/messages');
  }

  async function addMember(username: string) {
    setPanelBusy(true);
    setPanelError(null);
    try {
      const res = await api.addChatMember(chatId, username);
      setChat(res.chat);
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не удалось добавить человека');
    } finally {
      setPanelBusy(false);
    }
  }

  async function removeMember(username: string, displayName: string) {
    if (!window.confirm(`Удалить ${displayName} из чата? Человек потеряет доступ к переписке.`)) return;

    setPanelBusy(true);
    setPanelError(null);
    try {
      await api.removeChatMember(chatId, username);
      const res = await api.chat(chatId);
      setChat(res.chat);
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не удалось удалить участника');
    } finally {
      setPanelBusy(false);
    }
  }

  async function leaveChat() {
    if (!user) return;
    if (!window.confirm('Выйти из чата? Переписка станет недоступна, вернуться можно только по приглашению.')) return;

    setPanelBusy(true);
    setPanelError(null);
    try {
      await api.removeChatMember(chatId, user.username);
      leavePage();
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не удалось выйти из чата');
      setPanelBusy(false);
    }
  }

  async function removeChat() {
    if (!window.confirm('Удалить чат целиком? Переписка исчезнет у всех участников, вернуть её нельзя.')) return;

    setPanelBusy(true);
    setPanelError(null);
    try {
      await api.deleteChat(chatId);
      leavePage();
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не удалось удалить чат');
      setPanelBusy(false);
    }
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    const name = draftTitle.trim();
    if (!name || panelBusy) return;

    setPanelBusy(true);
    setPanelError(null);
    try {
      const res = await api.renameChat(chatId, name);
      setChat(res.chat);
      setRenaming(false);
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : 'Не удалось переименовать чат');
    } finally {
      setPanelBusy(false);
    }
  }

  if (gone) {
    return (
      <div className="thread-page">
        <header className="thread-top">
          <Link className="btn ghost small" to="/messages">
            Ко всем
          </Link>
        </header>
        <div className="notice">
          <p>
            <strong>{gone}.</strong> Возможно, чат удалили или вас больше нет среди участников.
            Переписка остальных при этом никуда не делась.
          </p>
        </div>
        <p className="empty" style={{ marginLeft: 0 }}>
          <Link to="/messages">Вернуться к сообщениям</Link>
        </p>
      </div>
    );
  }

  const left = LIMIT - text.length;

  return (
    <div className="thread-page">
      <header className="thread-top">
        <Link className="btn ghost small" to="/messages">
          Ко всем
        </Link>

        {chat && (
          <>
            <div className="chat-who">
              <Monogram username={chat.title} displayName={chat.title} size="sm" />
              <span className="chat-who-text">
                <h1 className="chat-title">{chat.title}</h1>
                <span className="thread-handle">
                  {chat.memberCount} {plural(chat.memberCount, 'участник', 'участника', 'участников')}
                </span>
              </span>
            </div>

            <button
              className="btn ghost small chat-members-toggle"
              type="button"
              aria-expanded={membersOpen}
              onClick={() => {
                setPanelError(null);
                setMembersOpen((v) => !v);
              }}
            >
              Участники
            </button>
          </>
        )}
      </header>

      {chat && membersOpen && (
        <section className="members" aria-label="Участники чата">
          {panelError && <p className="error">{panelError}</p>}

          <ul className="members-list">
            {chat.members.map((m) => (
              <li key={m.id}>
                <Link className="blocked-who members-who" to={`/u/${m.username}`}>
                  <Monogram
                    username={m.username}
                    displayName={m.displayName}
                    avatarUrl={m.avatarUrl}
                    size="sm"
                  />
                  <span>
                    <strong>{m.displayName}</strong>
                    <span className="blocked-handle">@{m.username}</span>
                  </span>
                </Link>

                {m.id === chat.ownerId && <span className="dialog-flag">владелец</span>}

                {chat.iAmOwner && m.id !== user?.id && (
                  <button
                    className="act act-danger"
                    type="button"
                    disabled={panelBusy}
                    onClick={() => void removeMember(m.username, m.displayName)}
                  >
                    Удалить
                  </button>
                )}
              </li>
            ))}
          </ul>

          {/* Звать людей может любой участник — так решено на сервере. */}
          {chat.memberCount < MAX_MEMBERS && (
            <MemberSearch
              label="Позвать ещё"
              exclude={chat.members.map((m) => m.username)}
              disabled={panelBusy}
              onPick={(u) => void addMember(u.username)}
            />
          )}

          {renaming ? (
            <form className="rename-form" onSubmit={rename}>
              <label className="field" htmlFor="chat-rename">
                <span>Новое название</span>
                <input
                  id="chat-rename"
                  type="text"
                  value={draftTitle}
                  maxLength={TITLE_LIMIT}
                  onChange={(e) => setDraftTitle(e.target.value)}
                />
              </label>
              <div className="members-actions">
                <button className="btn small" type="submit" disabled={panelBusy || !draftTitle.trim()}>
                  Сохранить
                </button>
                <button
                  className="btn ghost small"
                  type="button"
                  disabled={panelBusy}
                  onClick={() => setRenaming(false)}
                >
                  Отмена
                </button>
              </div>
            </form>
          ) : (
            <div className="members-actions">
              {chat.iAmOwner && (
                <button
                  className="act"
                  type="button"
                  disabled={panelBusy}
                  onClick={() => {
                    setDraftTitle(chat.title);
                    setRenaming(true);
                  }}
                >
                  Переименовать
                </button>
              )}
              <button className="act act-danger" type="button" disabled={panelBusy} onClick={() => void leaveChat()}>
                Выйти из чата
              </button>
              {chat.iAmOwner && (
                <button className="act act-danger" type="button" disabled={panelBusy} onClick={() => void removeChat()}>
                  Удалить чат
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <div className="chat">
        {loading ? (
          <p className="empty" style={{ marginLeft: 0 }}>Загружаю…</p>
        ) : (
          <>
            {cursor != null && (
              <div className="chat-more">
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Загружаю…' : 'Показать более старые'}
                </button>
              </div>
            )}

            {messages.length === 0 && (
              <p className="empty" style={{ marginLeft: 0 }}>
                <strong>Здесь пока пусто.</strong>
                Напишите первое сообщение — его увидят все участники.
              </p>
            )}

            {messages.map((m, i) => {
              const mine = m.author.id === user?.id;
              // Подпись автора — только над первым сообщением подряд: в группе
              // важно, кто говорит, но повторять имя у каждой реплики шумно.
              const sameAsPrev = i > 0 && messages[i - 1].author.id === m.author.id;

              return (
                <div key={m.id} className={mine ? 'bubble mine' : 'bubble'}>
                  {!mine && !sameAsPrev && (
                    <Link className="bubble-author" to={`/u/${m.author.username}`}>
                      {m.author.displayName}
                    </Link>
                  )}
                  <p>{m.body}</p>
                  <time dateTime={m.createdAt} title={fullDate(m.createdAt)}>
                    {timeAgo(m.createdAt)}
                  </time>
                </div>
              );
            })}
            <div ref={bottom} />
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <form className="chat-form" onSubmit={send}>
        <label className="sr-only" htmlFor="chat-input">
          Сообщение в чат
        </label>
        <textarea
          id="chat-input"
          rows={1}
          value={text}
          placeholder="Написать в чат…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="chat-form-foot">
          {left <= 120 && <span className={left < 0 ? 'counter over' : 'counter'}>{left}</span>}
          <button className="btn" type="submit" disabled={!text.trim() || left < 0 || sending}>
            {sending ? 'Отправляю…' : 'Отправить'}
          </button>
        </div>
      </form>
    </div>
  );
}
