/**
 * Подставной бэкенд для витрины на GitHub Pages.
 *
 * Pages раздаёт только статику: ни Node-процесса, ни базы, ни диска под
 * загрузки. Поэтому здесь те же методы, что у настоящего api, но всё живёт в
 * памяти вкладки. Перезагрузка возвращает засеянное состояние — так и написано
 * в плашке, чтобы демо ничего не обещало сверх того, что делает.
 *
 * В обычную сборку этот файл не попадает: см. переключение в api.ts.
 */
import type {
  ArchiveMonth, Author, Badges, BlockedUser, Chat, ChatMessage, ChatSummary, Comment,
  Conversation, ForwardRef, ForwardTarget, Media, Message, Notification as NotificationItem,
  NotificationKind, Page, Person, Post, Quote, Reaction, ReportReason, ReportTargetType, User,
} from '../api';
import { ApiError } from '../api';

type DbUser = {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  createdAt: string;
  email: string;
  password: string;
  /** Последний визит — для «в сети» и «был(а) … назад» в переписке. */
  lastSeenAt: string | null;
  /** Персонаж витрины, который «всегда в сети»: иначе через пару минут
   *  после открытия витрины зелёная точка у него погасла бы. */
  alwaysOnline?: boolean;
};

type DbPost = {
  id: number;
  authorId: number;
  body: string;
  createdAt: string;
  media: Media | null;
};

type DbComment = { id: number; postId: number; authorId: number; body: string; createdAt: string };
/** Поля действий с сообщениями — как колонки reply_to_id, edited_at, fwd_user_id на сервере. */
type DbExtras = { replyToId: number | null; editedAt: string | null; fwdUserId: number | null };
type DbMessage = DbExtras & { id: number; fromId: number; toId: number; body: string; createdAt: string; readAt: string | null };
/** Реакция: одна на человека на сообщение, как первичный ключ на сервере. */
type DbReaction = { messageId: number; userId: number; emoji: string; createdAt: string };

type DbNotification = {
  id: number;
  /** Получатель события. */
  userId: number;
  /** Тот, чьё действие его вызвало. */
  actorId: number;
  kind: NotificationKind;
  postId: number | null;
  commentId: number | null;
  chatId: number | null;
  createdAt: string;
  readAt: string | null;
};

type DbBlock = { blockerId: number; blockedId: number; createdAt: string };

/** Суррогатный `id` — не украшение: список листается по времени сохранения,
 *  а не по id записи, иначе сохранённая старая запись ушла бы в самый низ. */
type DbBookmark = { id: number; userId: number; postId: number; createdAt: string };

type DbReport = {
  reporterId: number;
  targetType: ReportTargetType;
  targetId: number;
  reason: ReportReason;
  note: string;
  createdAt: string;
};

type DbChat = { id: number; title: string; ownerId: number; createdAt: string };
/** `lastReadId` — ватерлиния прочитанного, как в схеме сервера: в группе
 *  получателей много, и отметка на каждом сообщении стоила бы таблицы N×M. */
type DbChatMember = { chatId: number; userId: number; joinedAt: string; lastReadId: number };
const NO_EXTRAS: DbExtras = { replyToId: null, editedAt: null, fwdUserId: null };

type DbChatMessage = DbExtras & { id: number; chatId: number; authorId: number; body: string; createdAt: string };

let users: DbUser[] = [];
let posts: DbPost[] = [];
let comments: DbComment[] = [];
let likes: { userId: number; postId: number }[] = [];
let follows: { followerId: number; followeeId: number }[] = [];
let messages: DbMessage[] = [];
let resets: { token: string; userId: number; expiresAt: number; usedAt: number | null }[] = [];
// Ниже — таблицы трёх поздних фич. Имена совпадают с именами методов витрины
// (`notifications`, `chats`, `chatMessages`): свойства объекта не перекрывают
// модульные переменные, так что внутри методов это по-прежнему таблицы.
let notifications: DbNotification[] = [];
let blocks: DbBlock[] = [];
let bookmarks: DbBookmark[] = [];
let reports: DbReport[] = [];
let chats: DbChat[] = [];
let chatMembers: DbChatMember[] = [];
let chatMessages: DbChatMessage[] = [];
let dmReactions: DbReaction[] = [];
let chatReactions: DbReaction[] = [];
/** «Печатает…»: ключ переписки|id человека → до какого момента. Как на
 *  сервере, живёт только в памяти и гаснет сам. */
const typingUntil = new Map<string, number>();
let meId: number | null = null;
let nextId = 1;

const id = () => nextId++;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** Даты витрины считаются от «сейчас», чтобы архив не устаревал со временем. */
const days = (count: number) => count * 24 * 60;

/** Небольшая задержка: без неё состояния «Загружаю…» мигают в один кадр. */
const tick = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 80));

const fail = (status: number, message: string): never => {
  throw new ApiError(status, message);
};

/** Картинки рисуем как SVG в data: — бинарники в статическую сборку тащить незачем. */
function gradient(from: string, to: string, w = 720, h = 480, label = '') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    ${label ? `<text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(w / 18)}" text-anchor="middle" opacity=".75">${label}</text>` : ''}
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function seed() {
  users = [];
  posts = [];
  comments = [];
  likes = [];
  follows = [];
  messages = [];
  resets = [];
  notifications = [];
  blocks = [];
  bookmarks = [];
  reports = [];
  chats = [];
  chatMembers = [];
  chatMessages = [];
  dmReactions = [];
  chatReactions = [];
  typingUntil.clear();
  nextId = 1;

  const make = (username: string, displayName: string, bio: string, avatar: string | null): DbUser => {
    const u: DbUser = {
      id: id(), username, displayName, bio, avatarUrl: avatar,
      createdAt: ago(days(280)), email: `${username}@example.test`, password: 'parol12345',
      lastSeenAt: null,
    };
    users.push(u);
    return u;
  };

  const demo = make('demo', 'Ерлан', 'Собираю портфолио и пишу о том, что строю.', gradient('#0e7863', '#8265ba', 256, 256));
  const marina = make('marina', 'Марина Штольц', 'Читаю больше, чем успеваю обдумывать.', gradient('#8265ba', '#3b7a9c', 256, 256));
  const oleg = make('oleg_k', 'Олег Кузьмин', 'Чиню станки старше себя.', gradient('#ad5f34', '#488048', 256, 256));
  const nina = make('nina', 'Нина Барто', 'Поля, плёнка, проявка на кухне.', null);

  // Три разных «в сети», чтобы в витрине было видно все подписи сразу.
  marina.alwaysOnline = true;
  oleg.lastSeenAt = ago(25);
  nina.lastSeenAt = ago(days(1) + 180);

  const post = (author: DbUser, body: string, minutes: number, media: Media | null = null) => {
    const p: DbPost = { id: id(), authorId: author.id, body, createdAt: ago(minutes), media };
    posts.push(p);
    return p;
  };

  // Записи прошлых месяцев. Заведены раньше свежих намеренно: id в витрине
  // растёт вместе с датой, иначе keyset-пагинация листала бы вразнобой.
  // Апрель
  const op1 = post(nina, 'Проявила первую за зиму плёнку. Почти весь ролик засвечен по краю, зато три кадра вышли лучше, чем я помнила саму съёмку.', days(152));
  post(marina, 'Начала записывать не то, что прочитала, а то, что вспомнилось через неделю после. Список выходит вдвое короче и вдвое честнее.', days(146));
  // Май
  const op3 = post(oleg, 'Сосед Борис отдал ящик метчиков — довоенных, в промасленной бумаге. Половину придётся править, но резьба у них глубже нынешней.', days(121));
  // Июнь
  post(demo, 'Переписал ленту на курсор вместо номера страницы. Записи перестали прыгать, когда кто-то публикует новое, пока ты листаешь.', days(96));
  post(marina, 'Третий день читаю в трамвае одну и ту же страницу. Не потому что сложно — потому что за окном интереснее.', days(92));
  // Июль
  const op6 = post(nina, 'Плёнка, забытая в камере с прошлого лета: половина кадров — чужой двор, половина — мой. Проявка показала, что двор один и тот же.', days(63));
  // Август
  post(demo, 'Добавил блокировки. Сложным оказалось не спрятать записи, а сделать так, чтобы по счётчикам нельзя было догадаться, что тебя заблокировали.', days(36));
  post(oleg, 'Станок гудит на полтона ниже, чем месяц назад. Подшипник ещё держит, но уже разговаривает.', days(33));
  post(marina, 'Выписала за месяц двенадцать цитат и ни одной не вспомнила в разговоре. Кажется, выписывать — это способ не запоминать.', days(29));

  const p1 = post(marina, 'Перечитала «Хазарский словарь» и поняла, что читала его неправильно оба предыдущих раза. Это не роман, а инструкция по чтению самого себя.', 12);
  const p2 = post(oleg, 'Сегодня в мастерской починил станок 1969 года. Инструкция к нему на четырёх языках, и ни один из них уже не звучит так, как звучал тогда.', 48);
  const p3 = post(nina, 'Вечер на набережной. Небо переходило из тёплого в холодное минут за десять — не успел дойти до моста.', 120, {
    url: gradient('#e08a4a', '#2c4a7c'),
    type: 'image',
    mime: 'image/svg+xml',
    name: 'zakat.png',
  });
  const p4 = post(demo, 'Поднял свою соцсеть с нуля: профили, лента, лайки, комментарии, подписки, медиа и личные сообщения. Внутри — Express и SQLite без единой нативной зависимости.', 200);

  likes.push({ userId: demo.id, postId: p1.id }, { userId: oleg.id, postId: p1.id }, { userId: nina.id, postId: p1.id });
  likes.push({ userId: marina.id, postId: p2.id });
  likes.push({ userId: demo.id, postId: p3.id }, { userId: marina.id, postId: p3.id });
  likes.push({ userId: marina.id, postId: p4.id });
  likes.push({ userId: demo.id, postId: op1.id }, { userId: marina.id, postId: op6.id });

  // Закладки витрины: сохранены в этом порядке, значит наверху списка будет
  // последняя строка. Закладка на чужую запись уведомления не создаёт.
  const save = (target: DbPost, minutes: number) => {
    bookmarks.push({ id: id(), userId: demo.id, postId: target.id, createdAt: ago(minutes) });
  };
  save(op3, days(110));
  save(op6, days(58));
  save(p1, 6);

  const answer = (post: DbPost, from: DbUser, body: string, minutes: number): DbComment => {
    const c: DbComment = { id: id(), postId: post.id, authorId: from.id, body, createdAt: ago(minutes) };
    comments.push(c);
    return c;
  };

  answer(p1, oleg, 'А какое издание? Мне попадалось только женское.', 10);
  answer(p1, marina, 'Мужское. Разница в одном абзаце, но он переворачивает финал.', 8);
  answer(p3, marina, 'Плёнка? Цвет совсем не цифровой.', 100);
  const c4 = answer(p4, oleg, 'Сколько ушло на первую версию? И почему без ORM — принципиально или просто не понадобилась?', 39);

  follows.push(
    { followerId: demo.id, followeeId: marina.id },
    { followerId: demo.id, followeeId: nina.id },
    { followerId: marina.id, followeeId: demo.id },
    { followerId: oleg.id, followeeId: marina.id },
  );

  const dm = (from: DbUser, to: DbUser, body: string, minutes: number, read = true, replyTo: DbMessage | null = null) => {
    const m: DbMessage = {
      id: id(), fromId: from.id, toId: to.id, body, createdAt: ago(minutes), readAt: read ? ago(minutes) : null,
      ...NO_EXTRAS, replyToId: replyTo?.id ?? null,
    };
    messages.push(m);
    return m;
  };

  dm(marina, demo, 'Слушай, ты был на той выставке в подвале на Гоголя?', 90);
  dm(demo, marina, 'Был, но не досмотрел — закрывались. Успел только первый зал.', 88);
  dm(marina, demo, 'Второй там и был весь смысл. Они его специально спрятали за лестницей.', 86);
  const weekend = dm(demo, marina, 'Тогда схожу ещё раз. В выходные?', 84);
  // Ответ с цитатой и реакция — чтобы в витрине всё это было видно сразу.
  dm(marina, demo, 'Давай в субботу до обеда, пока пусто.', 82, true, weekend);
  dmReactions.push({ messageId: weekend.id, userId: marina.id, emoji: '❤️', createdAt: ago(82) });
  dm(oleg, demo, 'Привет! Нашёл тот станок с фотографии — расскажу при встрече.', 30, false);
  dm(oleg, demo, 'И ещё: у тебя тот аккорд из поста — это Am7?', 25, false);

  // Групповой чат: владелец — тот, кем входят в витрину, иначе в панели
  // участников не видно ни переименования, ни удаления.
  const room: DbChat = { id: id(), title: 'Плёнка и проявка', ownerId: demo.id, createdAt: ago(75) };
  chats.push(room);

  const join = (u: DbUser, minutes: number) => {
    chatMembers.push({ chatId: room.id, userId: u.id, joinedAt: ago(minutes), lastReadId: 0 });
  };
  join(demo, 75);
  join(nina, 75);
  join(marina, 74);

  const say = (from: DbUser, body: string, minutes: number, replyTo: DbChatMessage | null = null): DbChatMessage => {
    const m: DbChatMessage = {
      id: id(), chatId: room.id, authorId: from.id, body, createdAt: ago(minutes), ...NO_EXTRAS, replyToId: replyTo?.id ?? null,
    };
    chatMessages.push(m);
    return m;
  };

  const invite = say(nina, 'Проявляем в субботу у меня? Бачок на две плёнки есть, проявителя хватит на четыре.', 70);
  const mine = say(demo, 'Давайте. Принесу вторую плёнку и таймер, а то в прошлый раз считали вслух.', 65);
  const last = say(marina, 'Я приду с камерой деда — она пролежала на антресолях лет десять, надо проверить затвор.', 59, invite);
  chatReactions.push(
    { messageId: mine.id, userId: nina.id, emoji: '👍', createdAt: ago(64) },
    { messageId: mine.id, userId: marina.id, emoji: '👍', createdAt: ago(60) },
    { messageId: last.id, userId: nina.id, emoji: '🔥', createdAt: ago(58) },
  );

  // Ватерлиния: у нас прочитано всё до своей реплики — реплика Марины остаётся
  // непрочитанной и даёт единицу в счётчике. У остальных прочитано всё, но по
  // фактическому id, а не «бесконечности»: иначе новые сообщения не были бы
  // непрочитанными и для них, если войти в витрину под их именем.
  for (const m of chatMembers) m.lastReadId = m.userId === demo.id ? mine.id : last.id;

  const event = (
    actor: DbUser,
    kind: NotificationKind,
    minutes: number,
    read: boolean,
    refs: { postId?: number; commentId?: number; chatId?: number } = {},
  ) => {
    notifications.push({
      id: id(), userId: demo.id, actorId: actor.id, kind,
      postId: refs.postId ?? null, commentId: refs.commentId ?? null, chatId: refs.chatId ?? null,
      createdAt: ago(minutes), readAt: read ? ago(minutes - 1) : null,
    });
  };

  // Четыре вида событий и три непрочитанных — ровно то состояние, которое
  // описывают счётчики в сайдбаре витрины: 2 письма, 1 чат, 3 события.
  event(marina, 'like', 190, true, { postId: p4.id });
  event(marina, 'chat_message', 59, false, { chatId: room.id });
  event(oleg, 'comment', 39, false, { postId: p4.id, commentId: c4.id });
  event(oleg, 'message', 25, false);

  meId = demo.id;
}

// Засев только в режиме витрины: в обычной сборке ветка мертва, и мок
// вместе с этими данными выбрасывается из бандла целиком.
if (import.meta.env.VITE_DEMO === '1') seed();

const byId = (userId: number) => users.find((u) => u.id === userId);
const byName = (username: string) => users.find((u) => u.username === username.toLowerCase());
const byEmail = (mail: string) => users.find((u) => u.email === mail.toLowerCase());

const me = () => (meId != null ? byId(meId) ?? null : null);
const requireMe = () => me() ?? fail(401, 'Требуется вход в аккаунт');

const author = (u: DbUser): Author => ({
  id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl,
});

/** Сам смотрящий в витрине всегда «сейчас» — отдельного учёта визитов здесь
 *  нет, и так он совпадает с тем, что делает loadUser на сервере. */
const seenAt = (u: DbUser) =>
  u.alwaysOnline || u.id === meId ? new Date().toISOString() : u.lastSeenAt;

/** Человек в переписке. Время визита скрыто для пары в блокировке — в обе
 *  стороны, как на сервере. */
const person = (u: DbUser): Person => ({
  ...author(u),
  lastSeenAt: meId != null && u.id !== meId && blockedPair(meId, u.id) ? null : seenAt(u),
});

/**
 * Блокировка симметрична: достаточно одной стороны, чтобы двое перестали
 * видеть контент друг друга и потеряли возможность писать. Одно правило вместо
 * десяти частных — ровно как на сервере.
 */
const blockedPair = (aId: number, bId: number) =>
  blocks.some((b) =>
    (b.blockerId === aId && b.blockedId === bId) || (b.blockerId === bId && b.blockedId === aId));

/** Скрыт ли автор от того, кто сейчас смотрит. Для гостя — никогда. */
const hidden = (authorId: number) => meId != null && blockedPair(meId, authorId);

const visiblePosts = () => posts.filter((p) => !hidden(p.authorId));

// ─ Поиск по записям ─────────────────────────────────────────────────────────

/**
 * `ё` сворачивается в `е` руками — и в запросе, и в тексте записи. На сервере
 * это делает `replace()` в триггере индекса: токенизатор FTS5 кириллическое `ё`
 * не трогает, а человек, который ищет «пленка», не должен промахиваться мимо
 * «плёнки». Замена посимвольная, длина строки не меняется.
 */
const foldSearchText = (value: string) => value.replace(/ё/g, 'е').replace(/Ё/g, 'Е');

/** Разбор строки на слова — той же границей, что и токенизатор `unicode61`. */
const wordsOf = (value: string) =>
  foldSearchText(value).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 0);

/** Термы запроса: не больше восьми, как потолок `ftsQuery()` на сервере. */
const searchTerms = (raw: string) => wordsOf(raw).slice(0, 8);

/**
 * Совпадение по **началу** слова, а не по словоформе: русского стеммера в
 * SQLite нет, и сервер ищет префиксом (`"проявк"*`). Термы соединяются через
 * И — набравший два слова ждёт записи, где есть оба.
 */
const matchesTerms = (body: string, terms: string[]) => {
  const words = wordsOf(body);
  return terms.every((term) => words.some((word) => word.startsWith(term)));
};
const visibleComments = (postId: number) =>
  comments.filter((c) => c.postId === postId && !hidden(c.authorId));

const publicUser = (u: DbUser): User => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  bio: u.bio,
  avatarUrl: u.avatarUrl,
  createdAt: u.createdAt,
  // Счётчик записей учитывает блокировку: «12 записей» над пустой лентой
  // выглядели бы поломкой сайта, а не следствием собственного решения.
  postCount: visiblePosts().filter((p) => p.authorId === u.id).length,
  followerCount: follows.filter((f) => f.followeeId === u.id).length,
  followingCount: follows.filter((f) => f.followerId === u.id).length,
  followedByMe: follows.some((f) => f.followerId === meId && f.followeeId === u.id),
});

const toPost = (p: DbPost): Post => ({
  id: p.id,
  body: p.body,
  createdAt: p.createdAt,
  likeCount: likes.filter((l) => l.postId === p.id).length,
  // Комментарии фильтруются блокировкой, значит и счётчик под записью — тоже,
  // иначе он разошёлся бы с длиной видимой ветки. Лайки не фильтруем: это
  // обезличенное число.
  commentCount: visibleComments(p.id).length,
  likedByMe: likes.some((l) => l.postId === p.id && l.userId === meId),
  bookmarkedByMe: bookmarks.some((b) => b.postId === p.id && b.userId === meId),
  media: p.media,
  author: author(byId(p.authorId)!),
});

const toComment = (c: DbComment): Comment => ({
  id: c.id,
  postId: c.postId,
  body: c.body,
  createdAt: c.createdAt,
  author: author(byId(c.authorId)!),
});

// ─ Действия с сообщениями: общее для ЛС и чатов ────────────────────────────

const REACTION_SET: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const EDIT_WINDOW_MS = 48 * 60 * 60_000;
const QUOTE_LEN = 120;
const TYPING_TTL_MS = 6_000;

/** Реакции сообщения глазами смотрящего: заблокированные не считаются. */
function reactionsOf(list: DbReaction[], messageId: number): Reaction[] {
  const out: Reaction[] = [];
  for (const r of list.filter((x) => x.messageId === messageId && !hidden(x.userId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const same = out.find((x) => x.emoji === r.emoji);
    if (same) {
      same.count += 1;
      same.mine ||= r.userId === meId;
    } else {
      out.push({ emoji: r.emoji, count: 1, mine: r.userId === meId });
    }
  }
  return out;
}

/** Цитата: чего нет среди видимых сообщений той же переписки — «удалено». */
function quoteOf(replyToId: number | null, visible: { id: number; body: string; authorId: number }[]): Quote | null {
  if (replyToId == null) return null;
  const m = visible.find((x) => x.id === replyToId);
  if (!m) return { id: replyToId, deleted: true };
  const a = byId(m.authorId)!;
  return {
    id: m.id,
    author: { id: a.id, displayName: a.displayName },
    body: m.body.length > QUOTE_LEN ? `${m.body.slice(0, QUOTE_LEN).trimEnd()}…` : m.body,
  };
}

const forwardedOf = (fwdUserId: number | null) => {
  const u = fwdUserId != null ? byId(fwdUserId) : undefined;
  return u ? { username: u.username, displayName: u.displayName } : null;
};

const pairOf = (m: DbMessage) =>
  messages.filter((x) => (x.fromId === m.fromId && x.toId === m.toId) || (x.fromId === m.toId && x.toId === m.fromId));

const toMessage = (m: DbMessage): Message => ({
  id: m.id, body: m.body, createdAt: m.createdAt, fromId: m.fromId, toId: m.toId, readAt: m.readAt,
  editedAt: m.editedAt,
  forwardedFrom: forwardedOf(m.fwdUserId),
  replyTo: quoteOf(m.replyToId, pairOf(m).map((x) => ({ id: x.id, body: x.body, authorId: x.fromId }))),
  reactions: reactionsOf(dmReactions, m.id),
});

/** Правка: своё, не пересланное, в первые двое суток — те же правила, что на сервере. */
function assertEditable(authorId: number, createdAt: string, fwdUserId: number | null, u: DbUser) {
  if (authorId !== u.id) fail(403, 'Изменить можно только своё сообщение');
  if (Date.now() - Date.parse(createdAt) > EDIT_WINDOW_MS) fail(403, 'Сообщение можно изменить только в течение 48 часов');
  if (fwdUserId != null) fail(403, 'Пересланное сообщение изменить нельзя');
}

function setReaction(list: DbReaction[], messageId: number, userId: number, emoji: string | null) {
  const at = list.findIndex((r) => r.messageId === messageId && r.userId === userId);
  if (at >= 0) list.splice(at, 1);
  if (emoji) {
    if (!REACTION_SET.includes(emoji)) fail(400, 'Такой реакции нет');
    list.push({ messageId, userId, emoji, createdAt: new Date().toISOString() });
  }
}

const pairThread = (a: number, b: number) =>
  messages.filter((m) => (m.fromId === a && m.toId === b) || (m.fromId === b && m.toId === a));

/** Сообщение пары «я — собеседник» по id. Чужое и несуществующее — одно 404. */
function requirePairMessage(username: string, messageId: number) {
  const u = requireMe()!;
  const other = byName(username);
  if (!other) fail(404, 'Пользователь не найден');
  const m = pairThread(u.id, other!.id).find((x) => x.id === messageId);
  if (!m) fail(404, 'Сообщение не найдено');
  return { u, other: other!, m: m! };
}

const dmKey = (a: number, b: number) => `dm:${Math.min(a, b)}-${Math.max(a, b)}`;
const setTyping = (key: string, userId: number) => typingUntil.set(`${key}|${userId}`, Date.now() + TYPING_TTL_MS);
const clearTyping = (key: string, userId: number) => typingUntil.delete(`${key}|${userId}`);
const isTyping = (key: string, userId: number) => (typingUntil.get(`${key}|${userId}`) ?? 0) > Date.now();

/** Источник пересылки глазами пересылающего; пересланное указывает на первоисточник. */
function forwardSource(source: ForwardRef, u: DbUser) {
  if (source.from === 'dm') {
    const m = messages.find((x) => x.id === source.id && (x.fromId === u.id || x.toId === u.id));
    if (!m) fail(404, 'Сообщение для пересылки не найдено');
    return { body: m!.body, fwdUserId: m!.fwdUserId ?? m!.fromId };
  }
  const m = chatMessages.find((x) => x.id === source.id && memberRow(x.chatId, u.id) && !hidden(x.authorId));
  if (!m) fail(404, 'Сообщение для пересылки не найдено');
  return { body: m!.body, fwdUserId: m!.fwdUserId ?? m!.authorId };
}

// ─ Живая витрина ──────────────────────────────────────────────────────────

/** Марина «всегда в сети» и отвечает: прочитает, попечатает, ответит. Так в
 *  витрине видно галочки, «печатает…» и ответ, не заводя второй вкладки. */
const MARINA_REPLIES = [
  'Ага, поняла!',
  'Звучит отлично.',
  'Давай так и сделаем.',
  'Хм, надо подумать. Напишу вечером.',
  'Согласна 🙂',
];

function marinaAnswers(me: DbUser) {
  const marina = byName('marina');
  if (!marina || blockedPair(me.id, marina.id)) return;
  const key = dmKey(me.id, marina.id);
  window.setTimeout(() => {
    for (const m of messages) if (m.fromId === me.id && m.toId === marina.id && !m.readAt) m.readAt = new Date().toISOString();
    setTyping(key, marina.id);
  }, 1_500);
  window.setTimeout(() => {
    clearTyping(key, marina.id);
    if (blockedPair(me.id, marina.id)) return;
    messages.push({
      id: id(), fromId: marina.id, toId: me.id,
      body: MARINA_REPLIES[Math.floor(Math.random() * MARINA_REPLIES.length)],
      createdAt: new Date().toISOString(), readAt: null, ...NO_EXTRAS,
    });
    notify({ userId: me.id, actorId: marina.id, kind: 'message' });
  }, 5_000);
}

// ─ Уведомления ──────────────────────────────────────────────────────────────

type NotifyInput = {
  userId: number;
  actorId: number;
  kind: NotificationKind;
  postId?: number;
  commentId?: number;
  chatId?: number;
};

/**
 * Единственная точка создания события — как `notify()` на сервере. Все правила
 * живут здесь, а не размазаны по методам: себе не уведомляем, заблокированной
 * паре не уведомляем, лайк и подписка идемпотентны, сообщения схлопываются.
 */
function notify(input: NotifyInput) {
  const { userId, actorId, kind } = input;
  const post = input.postId ?? null;
  const comment = input.commentId ?? null;
  const chat = input.chatId ?? null;

  if (userId === actorId) return;
  if (blockedPair(userId, actorId)) return;

  const sameObject = (n: DbNotification) =>
    n.userId === userId && n.actorId === actorId && n.kind === kind
    && n.postId === post && n.commentId === comment && n.chatId === chat;

  // Лайк и подписка: включение-выключение не должно быть способом дёргать
  // человека бесконечно.
  if ((kind === 'like' || kind === 'follow') && notifications.some(sameObject)) return;

  // Сообщения схлопываются: на диалог или чат приходится не больше одного
  // непрочитанного события, иначе лента станет дублем переписки.
  if (kind === 'message' || kind === 'chat_message') {
    notifications = notifications.filter(
      (n) => n.readAt !== null
        || !(n.userId === userId && n.actorId === actorId && n.kind === kind && n.chatId === chat),
    );
  }

  notifications.push({
    id: id(), userId, actorId, kind,
    postId: post, commentId: comment, chatId: chat,
    createdAt: new Date().toISOString(), readAt: null,
  });
}

/** Снятие лайка и отписка убирают только **непрочитанное** событие о себе. */
function dropNotification(input: NotifyInput) {
  const post = input.postId ?? null;
  const chat = input.chatId ?? null;
  notifications = notifications.filter(
    (n) => n.readAt !== null
      || !(n.userId === input.userId && n.actorId === input.actorId && n.kind === input.kind
        && n.postId === post && n.chatId === chat),
  );
}

/** Гасит события получателя; необязательные фильтры сужают выборку. */
function markNotificationsRead(filter: {
  userId: number; kind?: NotificationKind; actorId?: number; chatId?: number;
}) {
  const now = new Date().toISOString();
  for (const n of notifications) {
    if (n.readAt || n.userId !== filter.userId) continue;
    if (filter.kind && n.kind !== filter.kind) continue;
    if (filter.actorId != null && n.actorId !== filter.actorId) continue;
    if (filter.chatId != null && n.chatId !== filter.chatId) continue;
    n.readAt = now;
  }
}

const unreadNotifications = (userId: number) =>
  notifications.filter((n) => n.userId === userId && !n.readAt).length;

/** Первая строка предмета, обрезанная до 80 символов — как на сервере. */
function excerpt(text: string) {
  const trimmed = text.trim();
  const line = trimmed.split('\n')[0].trim();
  if (line.length > 80) return `${line.slice(0, 80)}…`;
  return line.length < trimmed.length ? `${line}…` : line;
}

const toNotification = (n: DbNotification): NotificationItem => {
  const post = n.postId != null ? posts.find((p) => p.id === n.postId) : undefined;
  const comment = n.commentId != null ? comments.find((c) => c.id === n.commentId) : undefined;
  const room = n.chatId != null ? chats.find((c) => c.id === n.chatId) : undefined;

  return {
    id: n.id,
    kind: n.kind,
    createdAt: n.createdAt,
    readAt: n.readAt,
    actor: author(byId(n.actorId)!),
    post: post ? { id: post.id, excerpt: excerpt(post.body) } : null,
    comment: comment ? { id: comment.id, excerpt: excerpt(comment.body) } : null,
    chat: room ? { id: room.id, title: room.title } : null,
  };
};

// ─ Групповые чаты ───────────────────────────────────────────────────────────

const membersOf = (chatId: number) =>
  chatMembers
    .filter((m) => m.chatId === chatId)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId - b.userId);

const memberRow = (chatId: number, userId: number) =>
  chatMembers.find((m) => m.chatId === chatId && m.userId === userId);

/** Сообщения чата, видимые смотрящему: реплики заблокированных не выдаются,
 *  но состав участников остаётся полным. Порядок — старые сверху. */
const visibleChatMessages = (chatId: number) =>
  chatMessages
    .filter((m) => m.chatId === chatId && !hidden(m.authorId))
    .sort((a, b) => a.id - b.id);

const toChatMessage = (m: DbChatMessage): ChatMessage => ({
  id: m.id, chatId: m.chatId, body: m.body, createdAt: m.createdAt, author: author(byId(m.authorId)!),
  editedAt: m.editedAt,
  forwardedFrom: forwardedOf(m.fwdUserId),
  replyTo: quoteOf(m.replyToId, visibleChatMessages(m.chatId)),
  reactions: reactionsOf(chatReactions, m.id),
});

/** Сообщение чата, видимое смотрящему, или 404. */
function requireChatMessage(chatId: number, messageId: number) {
  const m = visibleChatMessages(chatId).find((x) => x.id === messageId);
  if (!m) fail(404, 'Сообщение не найдено');
  return m!;
}

const toChat = (c: DbChat): Chat => {
  const members = membersOf(c.id).map((m) => person(byId(m.userId)!));
  return {
    id: c.id,
    title: c.title,
    ownerId: c.ownerId,
    createdAt: c.createdAt,
    members,
    memberCount: members.length,
    iAmOwner: c.ownerId === meId,
  };
};

/** Самая дальняя ватерлиния среди остальных участников — две галочки у своих. */
const othersReadUpTo = (chatId: number, userId: number) =>
  chatMembers
    .filter((m) => m.chatId === chatId && m.userId !== userId)
    .reduce((top, m) => Math.max(top, m.lastReadId), 0);

const chatUnread = (chatId: number, userId: number) => {
  const seen = memberRow(chatId, userId)?.lastReadId ?? 0;
  return visibleChatMessages(chatId).filter((m) => m.id > seen && m.authorId !== userId).length;
};

/**
 * Доступ к чату. Посторонний получает **404, а не 403**: существование чужого
 * чата не должно подтверждаться тем, кого в нём нет.
 */
function requireChat(chatId: number) {
  const u = requireMe()!;
  const chat = chats.find((c) => c.id === chatId);
  if (!chat || !memberRow(chatId, u.id)) fail(404, 'Чат не найден');
  return { u, chat: chat! };
}

const TITLE_MAX = 60;
const MEMBERS_MAX = 20;

function checkTitle(raw: unknown) {
  const title = typeof raw === 'string' ? raw.trim() : '';
  if (!title) fail(400, '«название чата»: минимум 1 символов');
  if (title.length > TITLE_MAX) fail(400, `«название чата»: максимум ${TITLE_MAX} символов`);
  return title;
}

const PAGE = 20;
/** `YYYY` или `YYYY-MM` — та же проверка, что и на сервере. */
const PERIOD_RE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
/** Ответ поиска: `query` возвращается обратно, чтобы экран знал, что подсвечивать. */
type SearchPage = { posts: Post[]; nextCursor: number | null; query: string };
/** Страница переписки — и в личных сообщениях, и в чатах. */
const CHAT_PAGE = 30;
const BODY_MAX = 1000;

/**
 * Ошибка метода витрины — отклонённый промис, как у настоящего api, а не
 * исключение в момент вызова. Методы проверяют ввод через `fail()` ещё до
 * `tick()`, и без этой обёртки `api.x().catch(...)` на экране не срабатывал
 * бы вовсе: исключение вылетало раньше, чем появлялся промис, и роняло
 * страницу целиком (так было со ссылкой на несуществующий чат).
 */
function rejectInsteadOfThrow<T extends object>(methods: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(methods)) {
    wrapped[name] = (...args: unknown[]) => {
      try {
        return (fn as (...a: unknown[]) => unknown)(...args);
      } catch (err) {
        return Promise.reject(err);
      }
    };
  }
  return wrapped as T;
}

export const mockApi = rejectInsteadOfThrow({
  me: () => tick({ user: me() ? publicUser(me()!) : null }),

  register: (input: { username: string; displayName: string; email: string; password: string }) => {
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      fail(400, 'Имя пользователя: 3–20 символов, только латиница, цифры и _');
    }
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail(400, 'Некорректный email');
    if (input.password.length < 8) fail(400, 'Пароль должен быть не короче 8 символов');
    if (byName(username)) fail(409, 'Это имя пользователя уже занято');
    if (users.some((u) => u.email === email)) fail(409, 'На этот email уже зарегистрирован аккаунт');

    const u: DbUser = {
      id: id(), username,
      displayName: input.displayName.trim() || username,
      bio: '', avatarUrl: null, createdAt: new Date().toISOString(), email, password: input.password,
      lastSeenAt: new Date().toISOString(),
    };
    users.push(u);
    meId = u.id;
    return tick({ user: publicUser(u) });
  },

  login: (input: { username: string; password: string }) => {
    const u = byName(input.username.trim());
    if (!u || u.password !== input.password) fail(401, 'Неверное имя пользователя или пароль');
    meId = u!.id;
    return tick({ user: publicUser(u!) });
  },

  logout: () => {
    meId = null;
    return tick({ ok: true as const });
  },

  forgotPassword: (rawEmail: string) => {
    const mail = rawEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) fail(400, 'Некорректный email');

    const user = byEmail(mail);
    const message = 'Если такой email зарегистрирован, на него отправлена ссылка';

    let demoLink: string | undefined;
    if (user) {
      resets = resets.filter((r) => !(r.userId === user.id && !r.usedAt));
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      resets.push({ token, userId: user.id, expiresAt: Date.now() + 30 * 60_000, usedAt: null });
      // Путь без BASE_URL — <Link to> сам добавляет basename роутера;
      // задвоить префикс, вставив его дважды, было бы легко.
      demoLink = `/reset-password/${token}`;
      // А в консоли нужен уже полный адрес, который можно скопировать в
      // строку браузера — как единственный канал у консоли сервера в проде.
      console.log(`✉️  [демо] ссылка для сброса пароля: ${location.origin}${import.meta.env.BASE_URL}reset-password/${token}`);
    }

    return tick({ ok: true as const, message, demoLink });
  },

  checkResetToken: (token: string) => {
    const r = resets.find((x) => x.token === token);
    const valid = Boolean(r && !r.usedAt && r.expiresAt > Date.now());
    return tick({ valid });
  },

  resetPassword: (token: string, password: string) => {
    if (password.length < 8) fail(400, 'Пароль должен быть не короче 8 символов');
    const r = resets.find((x) => x.token === token);
    if (!r || r.usedAt || r.expiresAt <= Date.now()) {
      fail(400, 'Ссылка недействительна или уже использована');
    }
    const user = byId(r!.userId)!;
    user.password = password;
    r!.usedAt = Date.now();
    if (meId === user.id) meId = null; // как и на бэкенде — сброс гасит текущую сессию
    return tick({ ok: true as const });
  },

  profile: (username: string) => {
    const u = byName(username);
    if (!u) fail(404, 'Пользователь не найден');
    const target = u!;
    // Профиль отдаётся всегда, но с флагами: записей у заблокированного будет
    // ноль, подписаться нельзя, написать нельзя.
    return tick({
      user: {
        ...publicUser(target),
        blockedByMe: blocks.some((b) => b.blockerId === meId && b.blockedId === target.id),
        blocksMe: blocks.some((b) => b.blockerId === target.id && b.blockedId === meId),
      },
    });
  },

  updateProfile: (input: { displayName: string; bio: string }) => {
    const u = requireMe()!;
    if (!input.displayName.trim()) fail(400, '«имя»: минимум 1 символов');
    if (input.bio.length > 200) fail(400, '«о себе»: максимум 200 символов');
    u.displayName = input.displayName.trim();
    u.bio = input.bio.trim();
    return tick({ user: publicUser(u) });
  },

  posts: (opts: { author?: string; cursor?: number | null; feed?: 'following'; period?: string } = {}) => {
    // Блокировка — главный фильтр ленты: и общей, и «по подпискам», и профильной.
    let list = visiblePosts().sort((a, b) => b.id - a.id);

    if (opts.period != null) {
      // Мусорный период — 400, в отличие от мусорного курсора: период человек
      // видит в адресе строки и может его исправить.
      if (!PERIOD_RE.test(opts.period)) fail(400, 'Некорректный период');
      // Границы месяца по UTC: в базе лежит ISO-время в UTC, и сравнение
      // префикса строки — ровно то же, что `substr(created_at, 1, length(:period))`.
      list = list.filter((p) => p.createdAt.slice(0, opts.period!.length) === opts.period);
    }
    if (opts.author) {
      const u = byName(opts.author);
      list = u ? list.filter((p) => p.authorId === u.id) : [];
    }
    if (opts.feed === 'following') {
      if (!me()) fail(401, 'Войдите, чтобы смотреть подписки');
      const mine = follows.filter((f) => f.followerId === meId).map((f) => f.followeeId);
      list = list.filter((p) => p.authorId === meId || mine.includes(p.authorId));
    }
    if (opts.cursor != null) list = list.filter((p) => p.id < opts.cursor!);

    const page = list.slice(0, PAGE);
    const result: Page = {
      posts: page.map(toPost),
      nextCursor: list.length > PAGE ? page.at(-1)!.id : null,
    };
    return tick(result);
  },

  createPost: (text: string, media?: File | null) => {
    const u = requireMe()!;
    const body = text.trim();
    if (!body && !media) fail(400, '«текст поста»: минимум 1 символов');
    if (body.length > 500) fail(400, '«текст поста»: максимум 500 символов');

    const p: DbPost = {
      id: id(), authorId: u.id, body, createdAt: new Date().toISOString(),
      media: media
        ? {
            // objectURL живёт, пока открыта вкладка — ровно столько же, сколько демо.
            url: URL.createObjectURL(media),
            type: media.type.startsWith('video/') ? 'video' : media.type.startsWith('audio/') ? 'audio' : 'image',
            mime: media.type,
            name: media.name,
          }
        : null,
    };
    posts.push(p);
    return tick({ post: toPost(p) });
  },

  deletePost: (postId: number) => {
    const u = requireMe()!;
    const p = posts.find((x) => x.id === postId);
    if (!p) fail(404, 'Пост не найден');
    if (p!.authorId !== u.id) fail(403, 'Это не ваш пост');
    posts = posts.filter((x) => x.id !== postId);
    comments = comments.filter((c) => c.postId !== postId);
    likes = likes.filter((l) => l.postId !== postId);
    bookmarks = bookmarks.filter((b) => b.postId !== postId);
    // События о записи ведут туда, где больше ничего нет — каскад, как в схеме.
    notifications = notifications.filter((n) => n.postId !== postId);
    return tick({ ok: true as const });
  },

  setLike: (postId: number, liked: boolean) => {
    const u = requireMe()!;
    likes = likes.filter((l) => !(l.postId === postId && l.userId === u.id));
    if (liked) likes.push({ userId: u.id, postId });

    const p = posts.find((x) => x.id === postId);
    if (p) {
      const event = { userId: p.authorId, actorId: u.id, kind: 'like' as const, postId };
      if (liked) notify(event);
      else dropNotification(event);
    }

    return tick({ likeCount: likes.filter((l) => l.postId === postId).length, likedByMe: liked });
  },

  comments: (postId: number) => {
    // Ветка под скрытой записью была бы дверью к ней самой.
    const p = posts.find((x) => x.id === postId);
    if (p && hidden(p.authorId)) fail(404, 'Пост не найден');
    return tick({ comments: visibleComments(postId).sort((a, b) => a.id - b.id).map(toComment) });
  },

  addComment: (postId: number, text: string) => {
    const u = requireMe()!;
    const body = text.trim();
    if (!body) fail(400, '«текст комментария»: минимум 1 символов');
    if (body.length > 300) fail(400, '«текст комментария»: максимум 300 символов');

    const p = posts.find((x) => x.id === postId);
    if (p && hidden(p.authorId)) fail(403, 'Комментировать этот пост нельзя');

    const c: DbComment = { id: id(), postId, authorId: u.id, body, createdAt: new Date().toISOString() };
    comments.push(c);
    if (p) notify({ userId: p.authorId, actorId: u.id, kind: 'comment', postId, commentId: c.id });
    return tick({ comment: toComment(c) });
  },

  deleteComment: (commentId: number) => {
    const u = requireMe()!;
    const c = comments.find((x) => x.id === commentId);
    if (!c) fail(404, 'Комментарий не найден');
    const post = posts.find((p) => p.id === c!.postId);
    if (c!.authorId !== u.id && post?.authorId !== u.id) fail(403, 'Можно удалять только свои комментарии');
    comments = comments.filter((x) => x.id !== commentId);
    notifications = notifications.filter((n) => n.commentId !== commentId);
    return tick({ ok: true as const });
  },

  setAvatar: (file: File) => {
    const u = requireMe()!;
    u.avatarUrl = URL.createObjectURL(file);
    return tick({ user: publicUser(u) });
  },

  removeAvatar: () => {
    const u = requireMe()!;
    u.avatarUrl = null;
    return tick({ user: publicUser(u) });
  },

  searchUsers: (q: string) => {
    const query = q.trim().toLowerCase();
    if (!query) return tick({ users: [] });

    // Обе стороны блокировки выпадают из выдачи друг у друга.
    const scored = users
      .filter((u) => !hidden(u.id))
      .map((u) => {
        const username = u.username.toLowerCase();
        const displayName = u.displayName.toLowerCase();
        let rank: number | null = null;
        if (username === query) rank = 0;
        else if (username.startsWith(query)) rank = 1;
        else if (displayName.startsWith(query)) rank = 2;
        else if (username.includes(query) || displayName.includes(query)) rank = 3;
        return rank === null ? null : { u, rank };
      })
      .filter((x): x is { u: DbUser; rank: number } => x !== null)
      .sort((a, b) => a.rank - b.rank || a.u.username.localeCompare(b.u.username))
      .slice(0, 20);

    return tick({ users: scored.map(({ u }) => author(u)) });
  },

  setFollow: (username: string, following: boolean) => {
    const u = requireMe()!;
    const target = byName(username);
    if (!target) fail(404, 'Пользователь не найден');
    if (target!.id === u.id) fail(400, 'Нельзя подписаться на себя');
    if (blockedPair(u.id, target!.id)) fail(400, 'Действие с этим пользователем недоступно');

    follows = follows.filter((f) => !(f.followerId === u.id && f.followeeId === target!.id));
    if (following) follows.push({ followerId: u.id, followeeId: target!.id });

    const event = { userId: target!.id, actorId: u.id, kind: 'follow' as const };
    if (following) notify(event);
    else dropNotification(event);

    return tick({
      followedByMe: following,
      followerCount: follows.filter((f) => f.followeeId === target!.id).length,
    });
  },

  conversations: () => {
    const u = requireMe()!;
    const mine = messages.filter((m) => m.fromId === u.id || m.toId === u.id);
    const others = [...new Set(mine.map((m) => (m.fromId === u.id ? m.toId : m.fromId)))];

    const list: Conversation[] = others
      .map((otherId) => {
        const thread = mine.filter((m) => m.fromId === otherId || m.toId === otherId);
        const last = thread.reduce((a, b) => (a.id > b.id ? a : b));
        return {
          user: person(byId(otherId)!),
          unread: messages.filter((m) => m.toId === u.id && m.fromId === otherId && !m.readAt).length,
          lastMessage: toMessage(last),
          // История не удаляется и диалог из списка не исчезает — меняется
          // только возможность отвечать.
          blocked: blockedPair(u.id, otherId),
        };
      })
      .sort((a, b) => b.lastMessage.id - a.lastMessage.id);

    return tick({
      conversations: list,
      unreadTotal: messages.filter((m) => m.toId === u.id && !m.readAt).length,
    });
  },

  thread: (username: string, cursor?: number | null) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');

    let list = messages
      .filter((m) =>
        (m.fromId === u.id && m.toId === other!.id) || (m.fromId === other!.id && m.toId === u.id))
      .sort((a, b) => b.id - a.id);

    if (cursor != null) list = list.filter((m) => m.id < cursor);

    const page = list.slice(0, CHAT_PAGE);
    return tick({
      user: person(other!),
      messages: page.map(toMessage).reverse(),
      nextCursor: list.length > CHAT_PAGE ? page.at(-1)!.id : null,
      blocked: blockedPair(u.id, other!.id),
      typing: !blockedPair(u.id, other!.id) && isTyping(dmKey(u.id, other!.id), other!.id),
    });
  },

  sendMessage: (username: string, text: string, replyTo?: number | null, forward?: ForwardRef) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    if (other!.id === u.id) fail(400, 'Нельзя написать самому себе');
    // Текст одинаков в обе стороны намеренно: по формулировке нельзя понять,
    // кто кого заблокировал.
    if (blockedPair(u.id, other!.id)) fail(403, 'Переписка с этим пользователем недоступна');

    const src = forward ? forwardSource(forward, u) : null;
    const body = src ? src.body : text.trim();
    if (!body) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (!src && replyTo != null && !pairThread(u.id, other!.id).some((m) => m.id === replyTo)) {
      fail(400, 'Сообщение, на которое вы отвечаете, не найдено');
    }

    const m: DbMessage = {
      id: id(), fromId: u.id, toId: other!.id, body,
      createdAt: new Date().toISOString(), readAt: null,
      replyToId: src ? null : replyTo ?? null, editedAt: null, fwdUserId: src?.fwdUserId ?? null,
    };
    messages.push(m);
    clearTyping(dmKey(u.id, other!.id), u.id);
    notify({ userId: other!.id, actorId: u.id, kind: 'message' });
    if (other!.username === 'marina') marinaAnswers(u);
    return tick({ message: toMessage(m) });
  },

  editMessage: (username: string, messageId: number, text: string) => {
    const { u, other, m } = requirePairMessage(username, messageId);
    assertEditable(m.fromId, m.createdAt, m.fwdUserId, u);
    if (blockedPair(u.id, other.id)) fail(403, 'Переписка с этим пользователем недоступна');
    const body = text.trim();
    if (!body) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (body !== m.body) {
      m.body = body;
      m.editedAt = new Date().toISOString();
    }
    return tick({ message: toMessage(m) });
  },

  deleteMessage: (username: string, messageId: number) => {
    const { u, m } = requirePairMessage(username, messageId);
    if (m.fromId !== u.id) fail(403, 'Удалить можно только своё сообщение');
    messages = messages.filter((x) => x.id !== m.id);
    dmReactions = dmReactions.filter((r) => r.messageId !== m.id);
    return tick({ ok: true as const });
  },

  reactMessage: (username: string, messageId: number, emoji: string | null) => {
    const { u, other, m } = requirePairMessage(username, messageId);
    if (emoji && blockedPair(u.id, other.id)) fail(403, 'Переписка с этим пользователем недоступна');
    setReaction(dmReactions, m.id, u.id, emoji);
    return tick({ message: toMessage(m) });
  },

  typing: (username: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    if (other!.id !== u.id && !blockedPair(u.id, other!.id)) setTyping(dmKey(u.id, other!.id), u.id);
    return tick({ ok: true as const });
  },

  /** Переслать — это та же отправка, только текст берётся из оригинала. */
  forward: (target: ForwardTarget, source: ForwardRef): Promise<{ message: Message | ChatMessage }> =>
    target.kind === 'dm'
      ? mockApi.sendMessage(target.username, '', null, source)
      : mockApi.sendChatMessage(target.id, '', null, source),

  markRead: (username: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    for (const m of messages) {
      if (m.toId === u.id && m.fromId === other!.id && !m.readAt) m.readAt = new Date().toISOString();
    }
    // Прочитанный диалог гасит и событие о нём: иначе лента событий жила бы
    // отдельной жизнью от переписки.
    markNotificationsRead({ userId: u.id, kind: 'message', actorId: other!.id });
    return tick({
      ok: true as const,
      unreadTotal: messages.filter((m) => m.toId === u.id && !m.readAt).length,
    });
  },

  // ─ Уведомления и счётчики ─────────────────────────────────────────────

  notifications: (cursor?: number | null) => {
    const u = requireMe()!;
    let list = notifications.filter((n) => n.userId === u.id).sort((a, b) => b.id - a.id);
    if (cursor != null) list = list.filter((n) => n.id < cursor);

    const page = list.slice(0, PAGE);
    return tick({
      notifications: page.map(toNotification),
      nextCursor: list.length > PAGE ? page.at(-1)!.id : null,
      // Общее число непрочитанных, а не число непрочитанных на странице.
      unread: unreadNotifications(u.id),
    });
  },

  readAllNotifications: () => {
    const u = requireMe()!;
    markNotificationsRead({ userId: u.id });
    return tick({ ok: true as const, unread: 0 });
  },

  readNotification: (notificationId: number) => {
    const u = requireMe()!;
    const n = notifications.find((x) => x.id === notificationId && x.userId === u.id);
    // Чужое и несуществующее — одинаково 404: посторонний не должен узнавать,
    // что такое событие вообще есть.
    if (!n) fail(404, 'Событие не найдено');
    if (!n!.readAt) n!.readAt = new Date().toISOString();
    return tick({ ok: true as const, unread: unreadNotifications(u.id) });
  },

  badges: (): Promise<Badges> => {
    const u = requireMe()!;
    return tick({
      messages: messages.filter((m) => m.toId === u.id && !m.readAt).length,
      chats: chatMembers
        .filter((m) => m.userId === u.id)
        .reduce((sum, m) => sum + chatUnread(m.chatId, u.id), 0),
      notifications: unreadNotifications(u.id),
    });
  },

  post: (postId: number) => {
    const p = posts.find((x) => x.id === postId);
    // Мусорный id, удалённая запись и запись заблокированного — одно и то же
    // «не найдено»: страница /p/<что угодно> показывает обычное пустое место.
    if (!p || hidden(p.authorId)) fail(404, 'Пост не найден');
    return tick({ post: toPost(p!) });
  },

  // ─ Поиск по записям, архив и закладки ─────────────────────────────────

  searchPosts: (q: string, opts: { author?: string; cursor?: number | null } = {}) => {
    // Сервер обрезает запрос до 100 символов — витрина обязана делать то же,
    // иначе длинный ввод дал бы здесь другую выдачу.
    const query = String(q).slice(0, 100);
    const terms = searchTerms(query);

    // Пустой и бессмысленный запрос («одни знаки препинания») — не ошибка, а
    // промежуточное состояние строки ввода. Сервер тоже отвечает 200.
    if (terms.length === 0) {
      const empty: SearchPage = { posts: [], nextCursor: null, query };
      return tick(empty);
    }

    // Порядок хронологический, а не по релевантности: это дневник, а не
    // поисковик, и keyset-пагинация по id работает только так.
    let list = visiblePosts()
      .filter((post) => matchesTerms(post.body, terms))
      .sort((a, b) => b.id - a.id);

    if (opts.author) {
      const u = byName(opts.author);
      list = u ? list.filter((post) => post.authorId === u.id) : [];
    }
    if (opts.cursor != null) list = list.filter((post) => post.id < opts.cursor!);

    const page = list.slice(0, PAGE);
    const result: SearchPage = {
      posts: page.map(toPost),
      nextCursor: list.length > PAGE ? page.at(-1)!.id : null,
      query,
    };
    return tick(result);
  },

  archive: (username: string) => {
    const u = byName(username);
    if (!u) fail(404, 'Пользователь не найден');

    // Числа в архиве считаются по той же видимости, что и лента: «12 записей»
    // над месяцем, который откроется пустым, читались бы как поломка.
    const counts = new Map<string, number>();
    for (const post of visiblePosts()) {
      if (post.authorId !== u!.id) continue;
      // Месяц — первые семь символов ISO-строки, то есть по UTC.
      const month = post.createdAt.slice(0, 7);
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }

    const months: ArchiveMonth[] = [...counts.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => b.month.localeCompare(a.month));

    return tick({ months, total: months.reduce((sum, m) => sum + m.count, 0) });
  },

  setBookmark: (postId: number, on: boolean) => {
    const u = requireMe()!;
    const p = posts.find((x) => x.id === postId);
    if (!p) fail(404, 'Пост не найден');
    // Сохранить скрытую блокировкой запись нельзя — ответ тот же «не найдено»,
    // что и у несуществующей. А вот снять закладку можно всегда: фильтр
    // блокировки стоит на чтении, строка закладки остаётся, и требуй мы
    // видимости на удалении — такая закладка застряла бы навсегда.
    // Сверено с BE-03 (`.team/inbox/to-frontend.md`).
    if (on && hidden(p!.authorId)) fail(404, 'Пост не найден');

    const saved = bookmarks.find((b) => b.userId === u.id && b.postId === postId);
    // Идемпотентно: повтор не создаёт вторую строку и не поднимает закладку
    // наверх списка — у неё остаётся прежний id, то есть прежнее место.
    if (on && !saved) {
      bookmarks.push({ id: id(), userId: u.id, postId, createdAt: new Date().toISOString() });
    }
    if (!on && saved) bookmarks = bookmarks.filter((b) => b !== saved);

    // Уведомления здесь нет намеренно: закладка приватна, и этим она
    // отличается от отметки — автор о ней знать не должен.
    return tick({ bookmarkedByMe: on });
  },

  bookmarks: (cursor?: number | null) => {
    const u = requireMe()!;

    // Фильтр стоит на чтении, а не на сохранении: заблокировали автора после
    // того, как сохранили его запись, — она пропадает из списка, строка
    // закладки остаётся. Правило одно — фильтровать там, где показываем.
    let list = bookmarks
      .filter((b) => b.userId === u.id)
      .filter((b) => {
        const post = posts.find((x) => x.id === b.postId);
        return post != null && !hidden(post.authorId);
      })
      .sort((a, b) => b.id - a.id);

    // Курсор — id закладки: список листается по времени сохранения.
    if (cursor != null) list = list.filter((b) => b.id < cursor);

    const page = list.slice(0, PAGE);
    const result: Page = {
      posts: page.map((b) => toPost(posts.find((x) => x.id === b.postId)!)),
      nextCursor: list.length > PAGE ? page.at(-1)!.id : null,
    };
    return tick(result);
  },

  // ─ Блокировки и жалобы ────────────────────────────────────────────────

  setBlock: (username: string, blocked: boolean) => {
    const u = requireMe()!;
    const target = byName(username);
    if (!target) fail(404, 'Пользователь не найден');
    if (target!.id === u.id) fail(400, 'Нельзя заблокировать себя');
    const other = target!;

    blocks = blocks.filter((b) => !(b.blockerId === u.id && b.blockedId === other.id));

    if (blocked) {
      blocks.push({ blockerId: u.id, blockedId: other.id, createdAt: new Date().toISOString() });
      // Иначе заблокированный остался бы в подписчиках, а его лайки — в
      // счётчике событий. Непрочитанные события чистятся в обе стороны:
      // те, что от него, — шум, а те, что о нём, вели бы на скрытую запись.
      follows = follows.filter(
        (f) => !((f.followerId === u.id && f.followeeId === other.id)
          || (f.followerId === other.id && f.followeeId === u.id)),
      );
      notifications = notifications.filter(
        (n) => n.readAt !== null
          || !((n.userId === u.id && n.actorId === other.id) || (n.userId === other.id && n.actorId === u.id)),
      );
    }

    // Снятие ничего не восстанавливает: подписки и погашенные события назад
    // не возвращаются, зато контент виден сразу.
    return tick({ blockedByMe: blocked });
  },

  blockedUsers: () => {
    const u = requireMe()!;
    // Только те, кого заблокировал я: свежие сверху. Те, кто заблокировал
    // меня, сюда не попадают — это чужое решение, не моё.
    const list: BlockedUser[] = blocks
      .filter((b) => b.blockerId === u.id)
      .slice()
      .reverse()
      .map((b) => author(byId(b.blockedId)!));
    return tick({ users: list });
  },

  report: (input: {
    targetType: ReportTargetType;
    targetId: number;
    reason: ReportReason;
    note?: string;
  }) => {
    const u = requireMe()!;

    const types: ReportTargetType[] = ['post', 'comment', 'user'];
    if (!types.includes(input.targetType)) fail(400, 'Неизвестный тип объекта жалобы');

    const targetId = Number(input.targetId);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) fail(400, 'Некорректный id объекта');

    const reasons: ReportReason[] = ['spam', 'abuse', 'adult', 'other'];
    if (!reasons.includes(input.reason)) fail(400, 'Причина: spam, abuse, adult или other');

    const note = (input.note ?? '').trim();
    if (note.length > 300) fail(400, '«комментарий»: максимум 300 символов');

    if (input.targetType === 'post' && !posts.some((p) => p.id === targetId)) fail(404, 'Пост не найден');
    if (input.targetType === 'comment' && !comments.some((c) => c.id === targetId)) fail(404, 'Комментарий не найден');
    if (input.targetType === 'user') {
      if (!byId(targetId)) fail(404, 'Пользователь не найден');
      if (targetId === u.id) fail(400, 'Нельзя пожаловаться на себя');
    }

    const already = reports.some(
      (r) => r.reporterId === u.id && r.targetType === input.targetType && r.targetId === targetId,
    );

    if (!already) {
      reports.push({
        reporterId: u.id, targetType: input.targetType, targetId,
        reason: input.reason, note, createdAt: new Date().toISOString(),
      });
      // Панели модератора в проекте нет, и жалоба честно уходит в лог — на
      // сервере в консоль процесса, здесь в консоль вкладки. Повтор не
      // печатается: это второй клик, а не второй сигнал.
      console.warn(
        `⚑ Жалоба: @${u.username} → ${input.targetType} #${targetId}, причина «${input.reason}»`
        + (note ? `, комментарий: ${note}` : ''),
      );
    }

    return tick({ ok: true as const, alreadyReported: already });
  },

  // ─ Групповые чаты ─────────────────────────────────────────────────────

  chats: () => {
    const u = requireMe()!;

    const list: ChatSummary[] = chatMembers
      .filter((m) => m.userId === u.id)
      .map((m) => chats.find((c) => c.id === m.chatId))
      .filter((c): c is DbChat => Boolean(c))
      .map((c) => {
        // Последнее сообщение — последнее **видимое**: реплика заблокированного
        // не показывается даже в превью.
        const last = visibleChatMessages(c.id).at(-1) ?? null;
        return {
          ...toChat(c),
          unread: chatUnread(c.id, u.id),
          lastMessage: last ? toChatMessage(last) : null,
          readUpTo: othersReadUpTo(c.id, u.id),
        };
      })
      // Чат без сообщений встаёт по своему созданию, иначе только что
      // собранный чат уезжал бы в самый низ списка.
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt).localeCompare(a.lastMessage?.createdAt ?? a.createdAt));

    return tick({ chats: list, unreadTotal: list.reduce((sum, c) => sum + c.unread, 0) });
  },

  createChat: (input: { title: string; members: string[] }) => {
    const u = requireMe()!;
    const title = checkTitle(input.title);
    if (!Array.isArray(input.members)) fail(400, 'Список участников должен быть массивом имён');

    // Участники приходят именами, а не id: id из тела запроса в проекте
    // принципиально не принимают. Своё имя и повторы схлопываются молча.
    const names = [...new Set(input.members.map((n) => (typeof n === 'string' ? n.trim().toLowerCase() : '')))]
      .filter((n) => n && n !== u.username);

    const invited: DbUser[] = [];
    for (const name of names) {
      const found = byName(name);
      if (!found) fail(400, `Пользователь «${name}» не найден`);
      if (blockedPair(u.id, found!.id)) fail(400, `Добавить «${name}» в чат нельзя`);
      invited.push(found!);
    }

    if (invited.length === 0) fail(400, 'В чате должно быть не меньше двух участников');
    if (invited.length + 1 > MEMBERS_MAX) fail(400, `В чате не больше ${MEMBERS_MAX} участников`);

    const now = new Date().toISOString();
    const chat: DbChat = { id: id(), title, ownerId: u.id, createdAt: now };
    chats.push(chat);
    chatMembers.push({ chatId: chat.id, userId: u.id, joinedAt: now, lastReadId: 0 });

    for (const person of invited) {
      chatMembers.push({ chatId: chat.id, userId: person.id, joinedAt: now, lastReadId: 0 });
      notify({ userId: person.id, actorId: u.id, kind: 'chat_invite', chatId: chat.id });
    }

    return tick({ chat: toChat(chat) });
  },

  chat: (chatId: number) => {
    const { chat } = requireChat(chatId);
    return tick({ chat: toChat(chat) });
  },

  renameChat: (chatId: number, title: string) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Переименовать чат может только владелец');
    chat.title = checkTitle(title);
    return tick({ chat: toChat(chat) });
  },

  deleteChat: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Удалить чат может только владелец');
    chats = chats.filter((c) => c.id !== chat.id);
    chatMembers = chatMembers.filter((m) => m.chatId !== chat.id);
    chatMessages = chatMessages.filter((m) => m.chatId !== chat.id);
    notifications = notifications.filter((n) => n.chatId !== chat.id);
    return tick({ ok: true as const });
  },

  chatMessages: (chatId: number, cursor?: number | null) => {
    const { u, chat } = requireChat(chatId);

    let list = visibleChatMessages(chat.id);
    if (cursor != null) list = list.filter((m) => m.id < cursor);

    // Старые сверху: страница — последние 30 по id, курсор — id самого
    // старого элемента страницы, то есть точка для подгрузки вверх.
    const page = list.slice(-CHAT_PAGE);
    return tick({
      chat: toChat(chat),
      messages: page.map(toChatMessage),
      nextCursor: list.length > CHAT_PAGE ? page[0].id : null,
      readUpTo: othersReadUpTo(chat.id, u.id),
      typing: membersOf(chat.id)
        .filter((m) => m.userId !== u.id && !hidden(m.userId) && isTyping(`chat:${chat.id}`, m.userId))
        .map((m) => ({ id: m.userId, displayName: byId(m.userId)!.displayName })),
    });
  },

  sendChatMessage: (chatId: number, text: string, replyTo?: number | null, forward?: ForwardRef) => {
    const { u, chat } = requireChat(chatId);
    const src = forward ? forwardSource(forward, u) : null;
    const body = src ? src.body : text.trim();
    if (!body) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (!src && replyTo != null && !visibleChatMessages(chat.id).some((m) => m.id === replyTo)) {
      fail(400, 'Сообщение, на которое вы отвечаете, не найдено');
    }

    const m: DbChatMessage = {
      id: id(), chatId: chat.id, authorId: u.id, body, createdAt: new Date().toISOString(),
      replyToId: src ? null : replyTo ?? null, editedAt: null, fwdUserId: src?.fwdUserId ?? null,
    };
    chatMessages.push(m);
    clearTyping(`chat:${chat.id}`, u.id);

    for (const member of membersOf(chat.id)) {
      notify({ userId: member.userId, actorId: u.id, kind: 'chat_message', chatId: chat.id });
    }

    return tick({ message: toChatMessage(m) });
  },

  editChatMessage: (chatId: number, messageId: number, text: string) => {
    const { u, chat } = requireChat(chatId);
    const m = requireChatMessage(chat.id, messageId);
    assertEditable(m.authorId, m.createdAt, m.fwdUserId, u);
    const body = text.trim();
    if (!body) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (body !== m.body) {
      m.body = body;
      m.editedAt = new Date().toISOString();
    }
    return tick({ message: toChatMessage(m) });
  },

  deleteChatMessage: (chatId: number, messageId: number) => {
    const { u, chat } = requireChat(chatId);
    const m = requireChatMessage(chat.id, messageId);
    // Своё — автор, любое — владелец чата, как админ группы.
    if (m.authorId !== u.id && chat.ownerId !== u.id) fail(403, 'Удалить можно только своё сообщение');
    chatMessages = chatMessages.filter((x) => x.id !== m.id);
    chatReactions = chatReactions.filter((r) => r.messageId !== m.id);
    return tick({ ok: true as const });
  },

  reactChatMessage: (chatId: number, messageId: number, emoji: string | null) => {
    const { u, chat } = requireChat(chatId);
    const m = requireChatMessage(chat.id, messageId);
    setReaction(chatReactions, m.id, u.id, emoji);
    return tick({ message: toChatMessage(m) });
  },

  chatTyping: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    setTyping(`chat:${chat.id}`, u.id);
    return tick({ ok: true as const });
  },

  markChatRead: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    const row = memberRow(chat.id, u.id)!;
    // Ватерлиния встаёт на максимальный id чата, включая скрытые реплики:
    // иначе они всплывали бы как непрочитанные после снятия блокировки.
    const top = chatMessages.filter((m) => m.chatId === chat.id).reduce((max, m) => Math.max(max, m.id), 0);
    row.lastReadId = Math.max(row.lastReadId, top);
    markNotificationsRead({ userId: u.id, kind: 'chat_message', chatId: chat.id });
    return tick({ ok: true as const, unread: 0 });
  },

  addChatMember: (chatId: number, username: string) => {
    // Звать людей может любой участник — удалять их может только владелец.
    const { u, chat } = requireChat(chatId);
    const name = username.trim().toLowerCase();
    const person = byName(name);
    if (!person) fail(400, `Пользователь «${name}» не найден`);
    if (memberRow(chat.id, person!.id)) fail(400, 'Этот человек уже в чате');
    if (blockedPair(u.id, person!.id)) fail(400, `Добавить «${name}» в чат нельзя`);
    if (membersOf(chat.id).length >= MEMBERS_MAX) fail(400, `В чате не больше ${MEMBERS_MAX} участников`);

    chatMembers.push({
      chatId: chat.id, userId: person!.id, joinedAt: new Date().toISOString(), lastReadId: 0,
    });
    notify({ userId: person!.id, actorId: u.id, kind: 'chat_invite', chatId: chat.id });

    return tick({ chat: toChat(chat) });
  },

  removeChatMember: (chatId: number, username: string) => {
    const { u, chat } = requireChat(chatId);
    const person = byName(username);
    const row = person ? memberRow(chat.id, person.id) : undefined;
    // Текст отличает этот 404 от «чата нет»: здесь скрывать уже нечего.
    if (!person || !row) fail(404, 'Участник не найден');

    const leaving = person!.id === u.id;
    if (!leaving && chat.ownerId !== u.id) fail(403, 'Удалять участников может только владелец');

    chatMembers = chatMembers.filter((m) => !(m.chatId === chat.id && m.userId === person!.id));
    // Ушедшему события об этом чате больше некуда вести.
    notifications = notifications.filter((n) => !(n.userId === person!.id && n.chatId === chat.id));

    const rest = membersOf(chat.id);
    if (rest.length === 0) {
      chats = chats.filter((c) => c.id !== chat.id);
      chatMessages = chatMessages.filter((m) => m.chatId !== chat.id);
      notifications = notifications.filter((n) => n.chatId !== chat.id);
    } else if (chat.ownerId === person!.id) {
      // Чат без владельца невозможно ни переименовать, ни распустить —
      // владение переходит участнику с самым ранним joined_at.
      chat.ownerId = rest[0].userId;
    }

    return leaving ? tick({ ok: true as const, left: true }) : tick({ ok: true as const });
  },
});
