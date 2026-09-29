import { type Attachment, type ChatFolder, type Media, type LastSeenPrivacy, type NotificationKind, type PrefKind, type Scheduled, type ReportReason, type ReportTargetType, ApiError } from '../api';

/** Состояние витрины: типы «таблиц», объект db и мелкие помощники (id, tick, fail). */

export type DbUser = {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  createdAt: string;
  email: string | null;
  /** Пустая строка — пароля нет (аккаунт по номеру без двухэтапной проверки). */
  password: string;
  /** Номер в E.164 — как users.phone. */
  phone?: string | null;
  /** false — аккаунт создан по номеру и по логину не входит (users.password_login). */
  passwordLogin?: boolean;
  /** Последний визит — для «в сети» и «был(а) … назад» в переписке. */
  lastSeenAt: string | null;
  /** Персонаж витрины, который «всегда в сети»: иначе через пару минут
   *  после открытия витрины зелёная точка у него погасла бы. */
  alwaysOnline?: boolean;
  /** Кому видно время захода — как колонка last_seen_privacy. */
  lastSeenPrivacy?: LastSeenPrivacy;
};

export type DbPost = {
  id: number;
  authorId: number;
  body: string;
  createdAt: string;
  media: Media | null;
};

export type DbComment = { id: number; postId: number; authorId: number; body: string; createdAt: string };

/** Поля действий с сообщениями — как колонки reply_to_id, edited_at, fwd_user_id на сервере. */
/** Вложение витрины — ссылка blob: или data: прямо в памяти вкладки. */
export type DbExtras = {
  replyToId: number | null;
  editedAt: string | null;
  fwdUserId: number | null;
  /** Переслано из канала — подпись ведёт на канал, а не на человека. */
  fwdChannelId: number | null;
  attachment: Attachment | null;
  /** Стикер из встроенного набора — тогда текста нет. */
  sticker?: string | null;
};

export type DbChannel = { id: number; handle: string; title: string; description: string; ownerId: number; createdAt: string };

export type DbChannelSub = { channelId: number; userId: number; joinedAt: string; lastReadId: number };

export type DbChannelPost = {
  id: number; channelId: number; authorId: number; body: string; createdAt: string; editedAt: string | null;
  attachment: Attachment | null;
};

export type DbChannelComment = { id: number; postId: number; authorId: number; body: string; createdAt: string };

export type DbMessage = DbExtras & { id: number; fromId: number; toId: number; body: string; createdAt: string; readAt: string | null };

/** Реакция: одна на человека на сообщение, как первичный ключ на сервере. */
export type DbReaction = { messageId: number; userId: number; emoji: string; createdAt: string };

export type DbNotification = {
  id: number;
  /** Получатель события. */
  userId: number;
  /** Тот, чьё действие его вызвало. */
  actorId: number;
  kind: NotificationKind;
  postId: number | null;
  commentId: number | null;
  chatId: number | null;
  /** Сообщение группы у события «упоминание». */
  messageId?: number | null;
  createdAt: string;
  readAt: string | null;
};

export type DbBlock = { blockerId: number; blockedId: number; createdAt: string };

/** Суррогатный `id` — не украшение: список листается по времени сохранения,
 *  а не по id записи, иначе сохранённая старая запись ушла бы в самый низ. */
export type DbBookmark = { id: number; userId: number; postId: number; createdAt: string };

export type DbReport = {
  reporterId: number;
  targetType: ReportTargetType;
  targetId: number;
  reason: ReportReason;
  note: string;
  createdAt: string;
};

export type DbChat = { id: number; title: string; ownerId: number; createdAt: string };

/** `lastReadId` — ватерлиния прочитанного, как в схеме сервера: в группе
 *  получателей много, и отметка на каждом сообщении стоила бы таблицы N×M. */
export type DbChatMember = { chatId: number; userId: number; joinedAt: string; lastReadId: number };

export const NO_EXTRAS: DbExtras = { replyToId: null, editedAt: null, fwdUserId: null, fwdChannelId: null, attachment: null };

export type DbChatMessage = DbExtras & { id: number; chatId: number; authorId: number; body: string; createdAt: string };

/** Настройки чатов в списке — как таблица chat_prefs на сервере. */
export type DbPref = { userId: number; kind: PrefKind; targetId: number; pinnedAt: string | null; muted: boolean };

/** Закреплённое сообщение — одно на переписку, как pinned_messages на сервере. */
export type DbPin = { kind: PrefKind; scope: string; messageId: number };

/** Папки чатов — у каждого свои, в порядке вкладок. */
export type DbFolder = ChatFolder & { userId: number };

/** Опросы — как polls/poll_options/poll_votes: при сообщении группы или публикации. */
export type DbPoll = {
  id: number; kind: 'chat' | 'channel'; messageId: number; multiple: boolean; anonymous: boolean;
  closedAt: string | null; options: { id: number; text: string }[];
};

/** Отложенные сообщения — как scheduled_messages: ждут sendAt и уходят сами. */
export type DbScheduled = Scheduled & { userId: number; targetId: number };

/** Сеансы — чтобы в настройках было что показать и что завершить. */
export type DbSession = { id: number; userId: number; createdAt: string; userAgent: string | null };

/**
 * Всё состояние витрины — одним объектом: модули читают и переписывают поля
 * `db.x`, а не собственные копии. Перезагрузка вкладки возвращает засев.
 */
export const db = {
  users: [] as DbUser[],
  posts: [] as DbPost[],
  comments: [] as DbComment[],
  likes: [] as { userId: number; postId: number }[],
  follows: [] as { followerId: number; followeeId: number }[],
  messages: [] as DbMessage[],
  resets: [] as { token: string; userId: number; expiresAt: number; usedAt: number | null }[],
  notifications: [] as DbNotification[],
  blocks: [] as DbBlock[],
  bookmarks: [] as DbBookmark[],
  reports: [] as DbReport[],
  chats: [] as DbChat[],
  chatMembers: [] as DbChatMember[],
  chatMessages: [] as DbChatMessage[],
  dmReactions: [] as DbReaction[],
  chatReactions: [] as DbReaction[],
  channels: [] as DbChannel[],
  channelSubs: [] as DbChannelSub[],
  channelPosts: [] as DbChannelPost[],
  /** Просмотр — один на человека, как первичный ключ на сервере. */
  channelViews: [] as { postId: number; userId: number }[],
  postReactions: [] as DbReaction[],
  channelComments: [] as DbChannelComment[],
  /** Настройки чатов в списке — как таблица chat_prefs на сервере. */
  prefs: [] as DbPref[],
  /** Закреплённое сообщение — одно на переписку, как pinned_messages. */
  pins: [] as DbPin[],
  folders: [] as DbFolder[],
  /** Кого упомянули через @ в сообщении группы — как chat_mentions. */
  chatMentions: [] as { messageId: number; userId: number }[],
  polls: [] as DbPoll[],
  pollVotes: [] as { pollId: number; optionId: number; userId: number; createdAt: string }[],
  scheduledMessages: [] as DbScheduled[],
  sessions: [] as DbSession[],
  /** Сеанс этой вкладки — его нельзя «завершить», только выйти. */
  currentSession: null as number | null,
  /** Коды «из SMS» и билеты незаконченного входа — как phone_codes и phone_tickets. */
  phoneCodes: [] as { phone: string; purpose: 'login' | 'link' | 'delete'; userId: number | null; code: string; attempts: number; expiresAt: number; createdAt: number; used: boolean }[],
  phoneTickets: [] as { token: string; kind: 'signup' | 'password'; phone: string; userId: number | null; attempts: number; expiresAt: number }[],
  /** Кто вошёл в витрину; null — гость. */
  meId: null as number | null,
  nextId: 1,
};

/** «Печатает…»: ключ переписки|id человека → до какого момента. Как на
 *  сервере, живёт только в памяти и гаснет сам. */
export const typingUntil = new Map<string, number>();

export const id = () => db.nextId++;

export const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Даты витрины считаются от «сейчас», чтобы архив не устаревал со временем. */
export const days = (count: number) => count * 24 * 60;

/** Небольшая задержка: без неё состояния «Загружаю…» мигают в один кадр. */
export const tick = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 80));

export const fail = (status: number, message: string): never => {
  throw new ApiError(status, message);
};
