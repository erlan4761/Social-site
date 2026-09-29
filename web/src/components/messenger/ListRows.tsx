import { NavLink } from 'react-router-dom';
import type { ChannelSummary, ChatSummary, Conversation, Draft } from '../../api';
import { PresenceAvatar, Ticks, previewText } from '../Chat';
import { Icon } from '../Icon';
import { Monogram, SavedAvatar } from '../Monogram';
import { isOnline, listTime, plural } from '../../time';
import { SAVED_TITLE } from './rows';

/* ─ Строки списка ──────────────────────────────────────────────────────── */

/**
 * «Черновик: …» вместо последнего сообщения — как в Телеграме. У открытого
 * чата не показывается: там недописанное и так в поле ввода.
 */
function DraftLine({ draft }: { draft: Draft }) {
  return (
    <span className="dialog-last">
      <span className="dialog-draft">Черновик: </span>
      {previewText(draft.body, null)}
    </span>
  );
}

/** Аватар канала — монограмма по названию и значок рупора в углу: канал в
 *  списке сразу отличим от человека и от группы. */
export function ChannelAvatar({ title, size = 'md' }: { title: string; size?: 'sm' | 'md' }) {
  return (
    <span className={size === 'sm' ? 'channel-avatar sm' : 'channel-avatar'}>
      <Monogram username={title} displayName={title} size={size === 'sm' ? 'sm' : undefined} />
      <span className="channel-mark" aria-hidden="true">
        <Icon name="megaphone" size={size === 'sm' ? 10 : 12} />
      </span>
    </span>
  );
}

export function DmRow({ c, meId }: { c: Conversation; meId?: number }) {
  // «Избранное»: всё в нём своё, поэтому ни галочек, ни «Вы:», ни «в сети».
  const saved = c.user.id === meId;
  const mine = !saved && c.lastMessage.fromId === meId;
  const online = !saved && !c.blocked && isOnline(c.user.lastSeenAt);

  return (
    <NavLink className="dialog" to={`/messages/${c.user.username}`}>
      {({ isActive }) => (
        <>
          {saved ? <SavedAvatar /> : <PresenceAvatar person={c.user} />}
          <span className="dialog-body">
            <span className="dialog-head">
              <span className="dialog-name">
                {saved ? SAVED_TITLE : c.user.displayName}
                {online && <span className="sr-only">, в сети</span>}
              </span>
              {c.muted && <MutedMark />}
              {/* Кто кого заблокировал — не сообщаем: пометка одинакова для обеих сторон. */}
              {c.blocked && <span className="dialog-flag">блокировка</span>}
              <span className="dialog-time">
                {mine && <Ticks status={c.lastMessage.readAt ? 'read' : 'sent'} />}
                <time dateTime={c.lastMessage.createdAt}>{listTime(c.lastMessage.createdAt)}</time>
              </span>
            </span>
            <span className="dialog-foot">
              {c.draft && !isActive ? (
                <DraftLine draft={c.draft} />
              ) : (
                <span className={c.unread > 0 ? 'dialog-last unread' : 'dialog-last'}>
                  {mine && <span className="dialog-you">Вы: </span>}
                  {previewText(c.lastMessage.body, c.lastMessage.attachment, c.lastMessage.sticker)}
                </span>
              )}
              <RowTail unread={c.unread} muted={c.muted} pinned={Boolean(c.pinnedAt)} />
            </span>
          </span>
        </>
      )}
    </NavLink>
  );
}

export function ChatRow({ c, meId }: { c: ChatSummary; meId?: number }) {
  const last = c.lastMessage;
  const mine = last?.author.id === meId;
  const at = last?.createdAt ?? c.createdAt;

  return (
    <NavLink className="dialog" to={`/messages/c/${c.id}`}>
      {({ isActive }) => (
        <>
          {/* У общей переписки нет лица, но есть имя — по нему список читается так же быстро. */}
          <Monogram username={c.title} displayName={c.title} />
          <span className="dialog-body">
            <span className="dialog-head">
              <span className="dialog-name">{c.title}</span>
              {c.muted && <MutedMark />}
              <span className="dialog-time">
                {last && mine && <Ticks status={c.readUpTo >= last.id ? 'read' : 'sent'} />}
                <time dateTime={at}>{listTime(at)}</time>
              </span>
            </span>
            <span className="dialog-foot">
              {c.draft && !isActive ? (
                <DraftLine draft={c.draft} />
              ) : (
                <span className={c.unread > 0 ? 'dialog-last unread' : 'dialog-last'}>
                  {last ? (
                    <>
                      <span className="dialog-you">{mine ? 'Вы: ' : `${last.author.displayName}: `}</span>
                      {last.poll ? `Опрос: ${last.body}` : previewText(last.body, last.attachment, last.sticker)}
                    </>
                  ) : (
                    `${c.memberCount} ${plural(c.memberCount, 'участник', 'участника', 'участников')}, сообщений пока нет`
                  )}
                </span>
              )}
              {c.mentions > 0 && (
                <span className="badge at" title="Вас упомянули">
                  @<span className="sr-only">, вас упомянули</span>
                </span>
              )}
              <RowTail unread={c.unread} muted={c.muted} pinned={Boolean(c.pinnedAt)} />
            </span>
          </span>
        </>
      )}
    </NavLink>
  );
}

export function ChannelRow({ c }: { c: ChannelSummary }) {
  const last = c.lastPost;
  const at = last?.createdAt ?? c.createdAt;

  return (
    <NavLink className="dialog" to={`/messages/ch/${c.handle}`}>
      {({ isActive }) => (
        <>
          <ChannelAvatar title={c.title} />
          <span className="dialog-body">
            <span className="dialog-head">
              <span className="dialog-name">
                {c.title}
                <span className="sr-only">, канал</span>
              </span>
              {c.muted && <MutedMark />}
              <span className="dialog-time">
                <time dateTime={at}>{listTime(at)}</time>
              </span>
            </span>
            <span className="dialog-foot">
              {c.draft && !isActive ? (
                <DraftLine draft={c.draft} />
              ) : (
                <span className={c.unread > 0 ? 'dialog-last unread' : 'dialog-last'}>
                  {last
                    ? last.poll
                      ? `Опрос: ${last.body}`
                      : previewText(last.body, last.attachment)
                    : c.iAmOwner
                      ? 'Ваш канал. Опубликуйте первую запись'
                      : 'Публикаций пока нет'}
                </span>
              )}
              <RowTail unread={c.unread} muted={c.muted} pinned={Boolean(c.pinnedAt)} />
            </span>
          </span>
        </>
      )}
    </NavLink>
  );
}

/** Приглушённый чат — перечёркнутый колокольчик рядом с именем. */
function MutedMark() {
  return (
    <span className="dialog-muted" title="Уведомления выключены">
      <Icon name="bell-off" size={14} />
      <span className="sr-only">, без уведомлений</span>
    </span>
  );
}

/** Хвост строки: счётчик непрочитанного (серый у приглушённого) или булавка. */
function RowTail({ unread, muted, pinned }: { unread: number; muted: boolean; pinned: boolean }) {
  if (unread > 0) {
    return (
      <span className={muted ? 'badge muted' : 'badge'}>
        {unread}
        <span className="sr-only"> непрочитанных</span>
      </span>
    );
  }
  if (!pinned) return null;
  return (
    <span className="dialog-pin" title="Закреплён">
      <Icon name="pin" size={15} />
      <span className="sr-only">закреплён</span>
    </span>
  );
}
