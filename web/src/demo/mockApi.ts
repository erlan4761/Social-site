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
  ArchiveMonth, Attachment, AttachmentInput, Author, Badges, Channel, ChannelComment, ChannelPost, ChannelSummary,
  ChatFolder, ConversationHit, FolderInput, ForwardedFrom, BlockedUser, Chat, ChatMessage, ChatSummary, Comment,
  Conversation, ForwardRef, ForwardTarget, Media, Message, Notification as NotificationItem,
  LastSeenPrivacy, NotificationKind, Page, Person, PinnedPreview, PrefKind, Post, Quote, Reaction, ReportReason, ReportTargetType, User,
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
  /** Кому видно время захода — как колонка last_seen_privacy. */
  lastSeenPrivacy?: LastSeenPrivacy;
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
/** Вложение витрины — ссылка blob: или data: прямо в памяти вкладки. */
type DbExtras = {
  replyToId: number | null;
  editedAt: string | null;
  fwdUserId: number | null;
  /** Переслано из канала — подпись ведёт на канал, а не на человека. */
  fwdChannelId: number | null;
  attachment: Attachment | null;
};

type DbChannel = { id: number; handle: string; title: string; description: string; ownerId: number; createdAt: string };
type DbChannelSub = { channelId: number; userId: number; joinedAt: string; lastReadId: number };
type DbChannelPost = {
  id: number; channelId: number; authorId: number; body: string; createdAt: string; editedAt: string | null;
  attachment: Attachment | null;
};
type DbChannelComment = { id: number; postId: number; authorId: number; body: string; createdAt: string };
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
const NO_EXTRAS: DbExtras = { replyToId: null, editedAt: null, fwdUserId: null, fwdChannelId: null, attachment: null };

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
let channels: DbChannel[] = [];
let channelSubs: DbChannelSub[] = [];
let channelPosts: DbChannelPost[] = [];
/** Просмотр — один на человека, как первичный ключ на сервере. */
let channelViews: { postId: number; userId: number }[] = [];
let postReactions: DbReaction[] = [];
let channelComments: DbChannelComment[] = [];
/** Настройки чатов в списке — как таблица chat_prefs на сервере. */
type DbPref = { userId: number; kind: PrefKind; targetId: number; pinnedAt: string | null; muted: boolean };
let prefs: DbPref[] = [];
/** Закреплённое сообщение — одно на переписку, как pinned_messages на сервере. */
type DbPin = { kind: PrefKind; scope: string; messageId: number };
let pins: DbPin[] = [];
/** Папки чатов — у каждого свои, в порядке вкладок. */
type DbFolder = ChatFolder & { userId: number };
let folders: DbFolder[] = [];
/** Сеансы — чтобы в настройках было что показать и что завершить. */
type DbSession = { id: number; userId: number; createdAt: string; userAgent: string | null };
let sessions: DbSession[] = [];
let currentSession: number | null = null;
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

/**
 * «Голосовое» витрины: напетая мелодия из шести нот, собранная в WAV прямо в
 * браузере. Настоящую запись тащить в сборку незачем, а без неё плеер
 * голосовых в витрине было бы нечем показать тому, у кого нет микрофона.
 */
function hummedVoice(seconds: number): { url: string; wave: string } {
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const notes = [392, 440, 494, 440, 392, 330];
  const span = seconds / notes.length;
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, n * 2, true);

  const envelope = (t: number) => Math.sin(Math.PI * ((t % span) / span)) ** 0.6;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = notes[Math.min(notes.length - 1, Math.floor(t / span))];
    const s = envelope(t) * 0.3 * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t));
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true);
  }

  const wave = Array.from({ length: 48 }, (_, i) => Math.round(envelope(((i + 0.5) / 48) * seconds) * 8) + 1)
    .map((d) => Math.min(9, d))
    .join('');
  return { url: URL.createObjectURL(new Blob([view], { type: 'audio/wav' })), wave };
}

/**
 * «Кружок» витрины: четыре секунды анимации на холсте, записанные в WebM
 * тем же MediaRecorder, которым пишутся настоящие. Живой камеры у витрины
 * нет, а показать, как «кружок» выглядит и играет, хочется и без неё.
 */
async function paintedVideoNote(seconds: number): Promise<string | null> {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported('video/webm')) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 320;
  const g = canvas.getContext('2d');
  if (!g || typeof canvas.captureStream !== 'function') return null;

  const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: 'video/webm' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  const done = new Promise<string>((resolve) => {
    recorder.onstop = () => resolve(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
  });

  const start = performance.now();
  const frame = () => {
    const t = (performance.now() - start) / 1000;
    const hue = (200 + t * 40) % 360;
    const grad = g.createLinearGradient(0, 0, 320, 320);
    grad.addColorStop(0, `hsl(${hue} 55% 45%)`);
    grad.addColorStop(1, `hsl(${(hue + 70) % 360} 60% 55%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 320, 320);
    // Солнце, которое «встаёт» за четыре секунды.
    g.fillStyle = 'rgba(255, 236, 190, 0.9)';
    g.beginPath();
    g.arc(160, 250 - t * 30, 44, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '600 26px sans-serif';
    g.textAlign = 'center';
    g.fillText('привет с набережной', 160, 84);
    if (t < seconds) requestAnimationFrame(frame);
    else recorder.stop();
  };
  recorder.start();
  frame();
  return done;
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
  channels = [];
  channelSubs = [];
  channelPosts = [];
  channelViews = [];
  postReactions = [];
  prefs = [];
  pins = [];
  folders = [];
  sessions = [];
  currentSession = null;
  channelComments = [];
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
  const hum = hummedVoice(6);
  const voice = dm(marina, demo, '', 81);
  voice.attachment = { url: hum.url, kind: 'voice', mime: 'audio/wav', name: null, size: null, duration: 6, wave: hum.wave };
  const note = dm(marina, demo, '', 80);
  note.attachment = { url: '', kind: 'videonote', mime: 'video/webm', name: null, size: null, duration: 4, wave: null };
  // Видео дорисуется через пару секунд — запись холста асинхронна. До тех пор
  // «кружок» пустой; не умеет браузер записывать холст — сообщения не будет.
  void paintedVideoNote(4).then((url) => {
    if (url) note.attachment = { ...note.attachment!, url };
    else messages = messages.filter((m) => m.id !== note.id);
  });
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
  pins.push({ kind: 'chat', scope: String(room.id), messageId: invite.id });
  const tank = say(nina, 'Вот он, кстати.', 68);
  tank.attachment = {
    url: gradient('#3b7a9c', '#e08a4a', 720, 480, 'бачок и две плёнки'),
    kind: 'image', mime: 'image/svg+xml', name: 'bachok.jpg', size: null, duration: null, wave: null,
  };
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

  // Каналы. Канал Нины — чужой, на него подписан смотрящий, и последняя
  // публикация у него не прочитана. «Хроника изнутри» — свой: в нём витрина
  // даёт опубликовать самому.
  const channel = (owner: DbUser, handle: string, title: string, description: string, minutes: number) => {
    const c: DbChannel = { id: id(), handle, title, description, ownerId: owner.id, createdAt: ago(minutes) };
    channels.push(c);
    channelSubs.push({ channelId: c.id, userId: owner.id, joinedAt: c.createdAt, lastReadId: 0 });
    return c;
  };
  const publish = (c: DbChannel, body: string, minutes: number, attachment: Attachment | null = null) => {
    const post: DbChannelPost = {
      id: id(), channelId: c.id, authorId: c.ownerId, body, createdAt: ago(minutes), editedAt: null, attachment,
    };
    channelPosts.push(post);
    return post;
  };
  const sub = (c: DbChannel, u: DbUser, lastReadId: number) =>
    channelSubs.push({ channelId: c.id, userId: u.id, joinedAt: c.createdAt, lastReadId });
  const saw = (post: DbChannelPost, ...who: DbUser[]) => who.forEach((u) => channelViews.push({ postId: post.id, userId: u.id }));

  const notes = channel(nina, 'plenka_notes', 'Заметки о плёнке', 'Проявка дома, старые камеры и кадры, которые получились не так, как задумывалось.', days(40));
  const n1 = publish(notes, 'Как я проявляю дома: бачок, термометр, три раствора и полчаса тишины. Ничего сложного, если не спешить и не открывать бачок «одним глазком».', days(20));
  const n2 = publish(notes, 'Три кадра с засвеченной по краю плёнки. Засветка вышла красивее задуманного — оставлю так.', days(6), {
    url: gradient('#e08a4a', '#8265ba', 720, 480, 'три кадра, засветка по краю'),
    kind: 'image', mime: 'image/svg+xml', name: 'zasvetka.jpg', size: null, duration: null, wave: null,
  });
  const n3 = publish(notes, 'В субботу проявляем вместе с ребятами из чата. Напишу, что получилось, — и что не получилось тоже.', 180);
  saw(n1, nina, demo, marina, oleg);
  saw(n2, nina, demo, marina, oleg);
  saw(n3, nina, marina);
  sub(notes, demo, n2.id);
  sub(notes, marina, n3.id);
  postReactions.push(
    { messageId: n1.id, userId: marina.id, emoji: '❤️', createdAt: ago(days(19)) },
    { messageId: n1.id, userId: demo.id, emoji: '❤️', createdAt: ago(days(19)) },
    { messageId: n2.id, userId: oleg.id, emoji: '🔥', createdAt: ago(days(5)) },
  );
  channelComments.push(
    { id: id(), postId: n1.id, authorId: oleg.id, body: 'А какой проявитель берёшь?', createdAt: ago(days(19)) },
    { id: id(), postId: n1.id, authorId: nina.id, body: 'Родинал, 1+50 — он прощает почти всё.', createdAt: ago(days(19) - 30) },
  );

  const dev = channel(demo, 'chronika_dev', 'Хроника изнутри', 'Как устроен этот сайт: решения, ошибки и то, что пришлось переделывать.', days(10));
  pins.push({ kind: 'channel', scope: String(notes.id), messageId: n1.id });
  folders.push(
    { id: id(), userId: demo.id, title: 'Личное', types: ['dm'], include: [], exclude: [], excludeMuted: false, excludeRead: false },
    {
      id: id(), userId: demo.id, title: 'Плёнка', types: [],
      include: [{ kind: 'chat', id: room.id }, { kind: 'channel', id: notes.id }],
      exclude: [], excludeMuted: false, excludeRead: false,
    },
  );
  const d1 = publish(dev, 'Здесь пишу о том, как устроена «Хроника» изнутри. Первое: сообщения ходят опросом раз в три секунды, без WebSocket, — и этого хватает.', days(9));
  channelSubs.find((s) => s.channelId === dev.id && s.userId === demo.id)!.lastReadId = d1.id;
  sub(dev, marina, d1.id);
  sub(dev, oleg, d1.id);
  saw(d1, demo, marina, oleg);

  prefs.push(
    { userId: demo.id, kind: 'dm', targetId: marina.id, pinnedAt: ago(days(3)), muted: false },
    { userId: demo.id, kind: 'dm', targetId: oleg.id, pinnedAt: null, muted: true },
  );
  // Событие от приглушённого Олега в «Событиях» не появилось бы — убираем.
  notifications = notifications.filter((n) => !(n.kind === 'message' && n.actorId === oleg.id));

  // «Избранное»: заметка себе и пересланная реплика Марины.
  dm(demo, demo, 'Список на субботу: две плёнки Kodak Gold 200, фиксаж, забрать сканы с Литейной.', days(2));
  const kept = dm(demo, demo, 'Второй там и был весь смысл. Они его специально спрятали за лестницей.', 85);
  kept.fwdUserId = marina.id;

  sessions.push(
    { id: id(), userId: demo.id, createdAt: ago(days(20)), userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' },
    { id: id(), userId: demo.id, createdAt: ago(days(4)), userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  );
  openSession(demo.id);

  meId = demo.id;
}

function openSession(userId: number) {
  const s: DbSession = {
    id: id(), userId, createdAt: new Date().toISOString(),
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
  };
  sessions.push(s);
  currentSession = s.id;
}

/** Все сеансы человека, кроме текущего. Возвращает, сколько закрыто. */
function endOtherSessions(userId: number) {
  const before = sessions.length;
  sessions = sessions.filter((s) => s.userId !== userId || s.id === currentSession);
  return before - sessions.length;
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

const RECENT_MS = 3 * 864e5;

/** Показывает ли `owner` своё время человеку `otherId` — как shares() в presence.js. */
const sharesSeen = (owner: DbUser, otherId: number) => {
  const privacy = owner.lastSeenPrivacy ?? 'all';
  if (privacy === 'nobody') return false;
  if (privacy === 'follows') return follows.some((f) => f.followerId === owner.id && f.followeeId === otherId);
  return true;
};

/** Человек в переписке. Время визита скрыто для пары в блокировке и
 *  настройкой — взаимно, как на сервере; спрятанное — «был(а) недавно». */
const person = (u: DbUser): Person => {
  const seen = seenAt(u);
  if (meId == null || u.id === meId) return { ...author(u), lastSeenAt: seen };
  if (blockedPair(meId, u.id)) return { ...author(u), lastSeenAt: null, seenRecently: false };
  if (sharesSeen(u, meId) && sharesSeen(byId(meId)!, u.id)) return { ...author(u), lastSeenAt: seen, seenRecently: false };
  return { ...author(u), lastSeenAt: null, seenRecently: seen != null && Date.now() - Date.parse(seen) < RECENT_MS };
};

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
function quoteOf(
  replyToId: number | null,
  visible: { id: number; body: string; authorId: number; attachment: Attachment | null }[],
): Quote | null {
  if (replyToId == null) return null;
  const m = visible.find((x) => x.id === replyToId);
  if (!m) return { id: replyToId, deleted: true };
  const a = byId(m.authorId)!;
  const text = m.body || attachmentLabelOf(m.attachment);
  return {
    id: m.id,
    author: { id: a.id, displayName: a.displayName },
    body: text.length > QUOTE_LEN ? `${text.slice(0, QUOTE_LEN).trimEnd()}…` : text,
    attachmentKind: m.attachment?.kind ?? null,
  };
}

/** То же, что attachmentLabel() на сервере. */
function attachmentLabelOf(a: Attachment | null) {
  if (!a) return '';
  if (a.kind === 'image') return 'Фото';
  if (a.kind === 'video') return 'Видео';
  if (a.kind === 'voice') return 'Голосовое сообщение';
  if (a.kind === 'videonote') return 'Видеосообщение';
  if (a.kind === 'audio') return a.name || 'Аудио';
  return a.name || 'Файл';
}

/**
 * Вложение из выбранного файла. Настоящий сервер решает тип по первым байтам,
 * витрине хватает MIME из браузера: сюда никто, кроме смотрящего, ничего не
 * загружает, и бояться подмены некого.
 */
function attachmentFrom(input: AttachmentInput): Attachment {
  if (input.file.size > 40 * 1024 * 1024) fail(413, 'Файл слишком большой');
  const type = input.file.type;
  const kind: Attachment['kind'] = input.videoNote
    ? 'videonote'
    : input.voice
    ? 'voice'
    : type.startsWith('image/') ? 'image'
    : type.startsWith('video/') ? 'video'
    : type.startsWith('audio/') ? 'audio'
    : 'file';
  if (input.videoNote && (input.videoNote.duration < 1 || input.videoNote.duration > 60)) {
    fail(400, 'Длительность видеосообщения — от 1 до 60 секунд');
  }
  if (input.voice && (input.voice.duration < 1 || input.voice.duration > 300)) {
    fail(400, 'Длительность голосового — от 1 до 300 секунд');
  }
  return {
    url: URL.createObjectURL(input.file),
    kind,
    mime: type || 'application/octet-stream',
    name: input.voice || input.videoNote ? null : input.name ?? null,
    size: input.file.size,
    duration: input.voice?.duration ?? input.videoNote?.duration ?? null,
    wave: input.voice?.wave ?? null,
  };
}

const forwardedOf = (m: DbExtras): ForwardedFrom | null => {
  if (m.fwdChannelId != null) {
    const c = channels.find((x) => x.id === m.fwdChannelId);
    return c ? { kind: 'channel', handle: c.handle, title: c.title } : null;
  }
  const u = m.fwdUserId != null ? byId(m.fwdUserId) : undefined;
  return u ? { kind: 'user', username: u.username, displayName: u.displayName } : null;
};

const pairOf = (m: DbMessage) =>
  messages.filter((x) => (x.fromId === m.fromId && x.toId === m.toId) || (x.fromId === m.toId && x.toId === m.fromId));

const toMessage = (m: DbMessage): Message => ({
  id: m.id, body: m.body, createdAt: m.createdAt, fromId: m.fromId, toId: m.toId, readAt: m.readAt,
  editedAt: m.editedAt,
  forwardedFrom: forwardedOf(m),
  replyTo: quoteOf(m.replyToId, pairOf(m).map((x) => ({ id: x.id, body: x.body, authorId: x.fromId, attachment: x.attachment }))),
  reactions: reactionsOf(dmReactions, m.id),
  attachment: m.attachment,
});

/** Правка: своё, не пересланное, в первые двое суток — те же правила, что на сервере. */
function assertEditable(authorId: number, createdAt: string, fwdUserId: number | null, u: DbUser, fwdChannelId: number | null = null) {
  if (authorId !== u.id) fail(403, 'Изменить можно только своё сообщение');
  if (Date.now() - Date.parse(createdAt) > EDIT_WINDOW_MS) fail(403, 'Сообщение можно изменить только в течение 48 часов');
  if (fwdUserId != null || fwdChannelId != null) fail(403, 'Пересланное сообщение изменить нельзя');
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

/**
 * Поиск по переписке — те же правила, что на сервере: ё → е, регистр не
 * важен, все слова должны встретиться, ищется и имя файла; свежие сверху.
 */
function findHits<T extends { id: number; body: string; createdAt: string; attachment: Attachment | null }>(
  q: string,
  list: T[],
  authorOf: (m: T) => number | null,
): ConversationHit[] {
  if (q.trim().length > 100) fail(400, 'Запрос длиннее 100 символов');
  const terms = wordsOf(q).slice(0, 8);
  if (terms.length === 0) return [];
  return [...list]
    .sort((a, b) => b.id - a.id)
    .filter((m) => {
      const text = foldSearchText(`${m.body} ${m.attachment?.name ?? ''}`).toLowerCase();
      return terms.every((t) => text.includes(t));
    })
    .slice(0, 50)
    .map((m) => {
      const who = authorOf(m);
      const a = who != null ? byId(who) : undefined;
      return {
        id: m.id,
        body: m.body || attachmentLabelOf(m.attachment),
        createdAt: m.createdAt,
        author: a ? { id: a.id, displayName: a.displayName } : null,
      };
    });
}

/**
 * Удаление аккаунта в витрине — то же, что каскад на сервере: всё его,
 * общие группы переходят старейшему участнику, группа, где он был один, и
 * его каналы исчезают вместе с тем, что на них ссылается.
 */
function dropUser(uid: number) {
  const goneChats = new Set<number>();
  for (const c of chats.filter((x) => chatMembers.some((m) => m.chatId === x.id && m.userId === uid))) {
    const heir = chatMembers
      .filter((m) => m.chatId === c.id && m.userId !== uid)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
    if (heir) {
      if (c.ownerId === uid) c.ownerId = heir.userId;
    } else {
      goneChats.add(c.id);
    }
  }
  const goneChannels = new Set(channels.filter((c) => c.ownerId === uid).map((c) => c.id));
  const gonePosts = new Set(posts.filter((x) => x.authorId === uid).map((x) => x.id));
  const goneChannelPosts = new Set(
    channelPosts.filter((x) => goneChannels.has(x.channelId) || x.authorId === uid).map((x) => x.id),
  );
  const goneRef = (kind: PrefKind, target: number) =>
    (kind === 'dm' && target === uid) || (kind === 'chat' && goneChats.has(target)) || (kind === 'channel' && goneChannels.has(target));

  users = users.filter((x) => x.id !== uid);
  posts = posts.filter((x) => !gonePosts.has(x.id));
  comments = comments.filter((x) => x.authorId !== uid && !gonePosts.has(x.postId));
  likes = likes.filter((x) => x.userId !== uid && !gonePosts.has(x.postId));
  bookmarks = bookmarks.filter((x) => x.userId !== uid && !gonePosts.has(x.postId));
  follows = follows.filter((x) => x.followerId !== uid && x.followeeId !== uid);
  messages = messages.filter((x) => x.fromId !== uid && x.toId !== uid);
  dmReactions = dmReactions.filter((x) => x.userId !== uid && messages.some((m) => m.id === x.messageId));
  notifications = notifications.filter((x) => x.userId !== uid && x.actorId !== uid);
  blocks = blocks.filter((x) => x.blockerId !== uid && x.blockedId !== uid);
  reports = reports.filter((x) => x.reporterId !== uid);
  chats = chats.filter((x) => !goneChats.has(x.id));
  chatMembers = chatMembers.filter((x) => x.userId !== uid && !goneChats.has(x.chatId));
  chatMessages = chatMessages.filter((x) => x.authorId !== uid && !goneChats.has(x.chatId));
  chatReactions = chatReactions.filter((x) => x.userId !== uid && chatMessages.some((m) => m.id === x.messageId));
  channels = channels.filter((x) => !goneChannels.has(x.id));
  channelSubs = channelSubs.filter((x) => x.userId !== uid && !goneChannels.has(x.channelId));
  channelPosts = channelPosts.filter((x) => !goneChannelPosts.has(x.id));
  channelViews = channelViews.filter((x) => x.userId !== uid && !goneChannelPosts.has(x.postId));
  postReactions = postReactions.filter((x) => x.userId !== uid && !goneChannelPosts.has(x.messageId));
  channelComments = channelComments.filter((x) => x.authorId !== uid && !goneChannelPosts.has(x.postId));
  prefs = prefs.filter((x) => x.userId !== uid && !goneRef(x.kind, x.targetId));
  pins = pins.filter((x) =>
    !(x.kind === 'dm' && x.scope.split('-').map(Number).includes(uid)) &&
    !(x.kind === 'chat' && goneChats.has(Number(x.scope))) &&
    !(x.kind === 'channel' && goneChannels.has(Number(x.scope))));
  folders = folders
    .filter((f) => f.userId !== uid)
    .map((f) => ({
      ...f,
      include: f.include.filter((r) => !goneRef(r.kind, r.id)),
      exclude: f.exclude.filter((r) => !goneRef(r.kind, r.id)),
    }));
  sessions = sessions.filter((x) => x.userId !== uid);
}

const toFolder = ({ userId: _owner, ...f }: DbFolder): ChatFolder => ({ ...f, types: [...f.types], include: [...f.include], exclude: [...f.exclude] });
const myFolders = (userId: number) => folders.filter((f) => f.userId === userId).map(toFolder);

/** Те же правила, что на сервере: имя 1–12, виды из трёх, исключение побеждает. */
function checkFolder(input: FolderInput, current: ChatFolder | null): Omit<ChatFolder, 'id'> {
  const title = input.title === undefined && current ? current.title : (input.title ?? '').trim();
  if (!title) fail(400, '«название папки»: минимум 1 символов');
  if (title.length > 12) fail(400, '«название папки»: максимум 12 символов');
  const types = input.types ?? current?.types ?? [];
  if (types.some((x) => !['dm', 'chat', 'channel'].includes(x))) fail(400, 'Виды чатов — dm, chat или channel');
  const exclude = input.exclude ?? current?.exclude ?? [];
  const include = (input.include ?? current?.include ?? []).filter(
    (x) => !exclude.some((e) => e.kind === x.kind && e.id === x.id),
  );
  if (types.length === 0 && include.length === 0) fail(400, 'В папке должны быть виды чатов или хотя бы один чат');
  return {
    title,
    types: [...new Set(types)],
    include,
    exclude,
    excludeMuted: input.excludeMuted ?? current?.excludeMuted ?? false,
    excludeRead: input.excludeRead ?? current?.excludeRead ?? false,
  };
}

const pinScope = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;
const pinnedOf = (kind: PrefKind, scope: string | number) => pins.find((x) => x.kind === kind && x.scope === String(scope));
const setPin = (kind: PrefKind, scope: string | number, messageId: number | null) => {
  pins = pins.filter((x) => !(x.kind === kind && x.scope === String(scope)));
  if (messageId != null) pins.push({ kind, scope: String(scope), messageId });
};
/** Закреплённое глазами смотрящего: не нашлось среди видимых — полосы нет. */
function pinPreview(kind: PrefKind, scope: string | number, visible: { id: number; body: string; attachment: Attachment | null }[]): PinnedPreview | null {
  const pin = pinnedOf(kind, scope);
  const m = pin ? visible.find((x) => x.id === pin.messageId) : undefined;
  return m ? { id: m.id, body: m.body || attachmentLabelOf(m.attachment), attachmentKind: m.attachment?.kind ?? null } : null;
}

const dmKey = (a: number, b: number) => `dm:${Math.min(a, b)}-${Math.max(a, b)}`;
const setTyping = (key: string, userId: number) => typingUntil.set(`${key}|${userId}`, Date.now() + TYPING_TTL_MS);
const clearTyping = (key: string, userId: number) => typingUntil.delete(`${key}|${userId}`);
const isTyping = (key: string, userId: number) => (typingUntil.get(`${key}|${userId}`) ?? 0) > Date.now();

/** Первоисточник: пересланное пересланного указывает туда же, куда оригинал. */
const origin = (m: DbExtras & { body: string }, author: number) =>
  m.fwdChannelId != null
    ? { body: m.body, fwdUserId: null, fwdChannelId: m.fwdChannelId, attachment: m.attachment }
    : { body: m.body, fwdUserId: m.fwdUserId ?? author, fwdChannelId: null, attachment: m.attachment };

/** Источник пересылки глазами пересылающего; пересланное указывает на первоисточник. */
function forwardSource(source: ForwardRef, u: DbUser) {
  if (source.from === 'dm') {
    const m = messages.find((x) => x.id === source.id && (x.fromId === u.id || x.toId === u.id));
    if (!m) fail(404, 'Сообщение для пересылки не найдено');
    return origin(m!, m!.fromId);
  }
  if (source.from === 'channel') {
    const post = channelPosts.find((x) => x.id === source.id);
    if (!post) fail(404, 'Сообщение для пересылки не найдено');
    return { body: post!.body, fwdUserId: null, fwdChannelId: post!.channelId, attachment: post!.attachment };
  }
  const m = chatMessages.find((x) => x.id === source.id && memberRow(x.chatId, u.id) && !hidden(x.authorId));
  if (!m) fail(404, 'Сообщение для пересылки не найдено');
  return origin(m!, m!.authorId);
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
const prefOf = (userId: number, kind: PrefKind, targetId: number) =>
  prefs.find((x) => x.userId === userId && x.kind === kind && x.targetId === targetId);
const mutedFor = (userId: number, kind: PrefKind, targetId: number | null) =>
  targetId != null && Boolean(prefOf(userId, kind, targetId)?.muted);
const prefFields = (userId: number, kind: PrefKind, targetId: number) => {
  const x = prefOf(userId, kind, targetId);
  return { pinnedAt: x?.pinnedAt ?? null, muted: Boolean(x?.muted) };
};
/** Общий счётчик ЛС — без приглушённых собеседников. */
const dmUnreadTotal = (userId: number) =>
  messages.filter((m) => m.toId === userId && !m.readAt && !mutedFor(userId, 'dm', m.fromId)).length;
const dropPrefs = (kind: PrefKind, targetId: number, userId?: number) => {
  prefs = prefs.filter((x) => !(x.kind === kind && x.targetId === targetId && (userId == null || x.userId === userId)));
};

function notify(input: NotifyInput) {
  const { userId, actorId, kind } = input;
  const post = input.postId ?? null;
  const comment = input.commentId ?? null;
  const chat = input.chatId ?? null;

  if (userId === actorId) return;
  if (blockedPair(userId, actorId)) return;
  // Приглушённая переписка событий не создаёт.
  if (kind === 'message' && mutedFor(userId, 'dm', actorId)) return;
  if (kind === 'chat_message' && mutedFor(userId, 'chat', chat)) return;

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
  forwardedFrom: forwardedOf(m),
  replyTo: quoteOf(m.replyToId, visibleChatMessages(m.chatId)),
  reactions: reactionsOf(chatReactions, m.id),
  attachment: m.attachment,
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

// ─ Каналы ────────────────────────────────────────────────────────────────────

const CHANNEL_HANDLE_RE = /^[a-z][a-z0-9_]{3,31}$/;

const channelBy = (handle: string) => channels.find((c) => c.handle === handle.toLowerCase().replace(/^@/, ''));

function requireChannel(handle: string) {
  const u = requireMe()!;
  const c = channelBy(handle);
  if (!c) fail(404, 'Канал не найден');
  return { u, c: c! };
}

function requireOwner(handle: string) {
  const { u, c } = requireChannel(handle);
  if (c.ownerId !== u.id) fail(403, 'Публиковать и править канал может только владелец');
  return { u, c };
}

const subOf = (channelId: number, userId: number) =>
  channelSubs.find((s) => s.channelId === channelId && s.userId === userId);

/** Своё — не «непрочитанное»: владелец свои публикации и так видел. */
function channelUnread(s: DbChannelSub) {
  const c = channels.find((x) => x.id === s.channelId);
  if (!c || c.ownerId === s.userId) return 0;
  return channelPosts.filter((p) => p.channelId === s.channelId && p.id > s.lastReadId).length;
}

const toChannel = (c: DbChannel): Channel => {
  const owner = byId(c.ownerId);
  return {
    id: c.id, handle: c.handle, title: c.title, description: c.description, createdAt: c.createdAt,
    owner: owner ? author(owner) : null,
    iAmOwner: c.ownerId === meId,
    subscribed: meId != null && Boolean(subOf(c.id, meId)),
    subscriberCount: channelSubs.filter((s) => s.channelId === c.id).length,
  };
};

const toChannelPost = (p: DbChannelPost): ChannelPost => ({
  id: p.id, channelId: p.channelId, body: p.body, createdAt: p.createdAt, editedAt: p.editedAt,
  views: channelViews.filter((v) => v.postId === p.id).length,
  commentCount: channelComments.filter((c) => c.postId === p.id && !hidden(c.authorId)).length,
  attachment: p.attachment,
  reactions: reactionsOf(postReactions, p.id),
});

const postsOf = (channelId: number) => channelPosts.filter((p) => p.channelId === channelId).sort((a, b) => a.id - b.id);

function requirePost(channelId: number, postId: number) {
  const p = channelPosts.find((x) => x.id === postId && x.channelId === channelId);
  if (!p) fail(404, 'Публикация не найдена');
  return p!;
}

const toChannelComment = (c: DbChannelComment): ChannelComment => ({
  id: c.id, body: c.body, createdAt: c.createdAt, author: author(byId(c.authorId)!),
});

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
    openSession(u.id);
    return tick({ user: publicUser(u) });
  },

  login: (input: { username: string; password: string }) => {
    const u = byName(input.username.trim());
    if (!u || u.password !== input.password) fail(401, 'Неверное имя пользователя или пароль');
    meId = u!.id;
    openSession(u!.id);
    return tick({ user: publicUser(u!) });
  },

  logout: () => {
    sessions = sessions.filter((s) => s.id !== currentSession);
    currentSession = null;
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
        const thread = mine.filter((m) => (m.fromId === u.id ? m.toId : m.fromId) === otherId);
        const last = thread.reduce((a, b) => (a.id > b.id ? a : b));
        return {
          user: person(byId(otherId)!),
          unread: messages.filter((m) => m.toId === u.id && m.fromId === otherId && !m.readAt).length,
          lastMessage: toMessage(last),
          // История не удаляется и диалог из списка не исчезает — меняется
          // только возможность отвечать.
          blocked: blockedPair(u.id, otherId),
          ...prefFields(u.id, 'dm', otherId),
        };
      })
      .sort((a, b) => b.lastMessage.id - a.lastMessage.id);

    return tick({
      conversations: list,
      unreadTotal: dmUnreadTotal(u.id),
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
      pinned: pinPreview('dm', pinScope(u.id, other!.id), pairThread(u.id, other!.id)),
    });
  },

  sendMessage: (username: string, text: string, replyTo?: number | null, forward?: ForwardRef, file?: AttachmentInput) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    // Себе — это «Избранное»: сразу прочитано, без события.
    const saved = other!.id === u.id;
    // Текст одинаков в обе стороны намеренно: по формулировке нельзя понять,
    // кто кого заблокировал.
    if (blockedPair(u.id, other!.id)) fail(403, 'Переписка с этим пользователем недоступна');

    const src = forward ? forwardSource(forward, u) : null;
    const body = src ? src.body : text.trim();
    const attachment = src ? src.attachment : file ? attachmentFrom(file) : null;
    if (!body && !attachment) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (!src && replyTo != null && !pairThread(u.id, other!.id).some((m) => m.id === replyTo)) {
      fail(400, 'Сообщение, на которое вы отвечаете, не найдено');
    }

    const m: DbMessage = {
      id: id(), fromId: u.id, toId: other!.id, body,
      createdAt: new Date().toISOString(), readAt: saved ? new Date().toISOString() : null,
      replyToId: src ? null : replyTo ?? null, editedAt: null, fwdUserId: src?.fwdUserId ?? null, fwdChannelId: src?.fwdChannelId ?? null, attachment,
    };
    messages.push(m);
    clearTyping(dmKey(u.id, other!.id), u.id);
    if (!saved) notify({ userId: other!.id, actorId: u.id, kind: 'message' });
    if (other!.username === 'marina') marinaAnswers(u);
    return tick({ message: toMessage(m) });
  },

  sendAttachment: (username: string, input: AttachmentInput) =>
    mockApi.sendMessage(username, input.body ?? '', input.replyTo ?? null, undefined, input),

  editMessage: (username: string, messageId: number, text: string) => {
    const { u, other, m } = requirePairMessage(username, messageId);
    assertEditable(m.fromId, m.createdAt, m.fwdUserId, u, m.fwdChannelId);
    if (blockedPair(u.id, other.id)) fail(403, 'Переписка с этим пользователем недоступна');
    const body = text.trim();
    if (!body && !m.attachment) fail(400, '«сообщение»: минимум 1 символов');
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
    if (pinnedOf('dm', pinScope(m.fromId, m.toId))?.messageId === m.id) setPin('dm', pinScope(m.fromId, m.toId), null);
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
      unreadTotal: dmUnreadTotal(u.id),
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
      messages: dmUnreadTotal(u.id),
      chats: chatMembers
        .filter((m) => m.userId === u.id)
        .filter((m) => !mutedFor(u.id, 'chat', m.chatId))
        .reduce((sum, m) => sum + chatUnread(m.chatId, u.id), 0),
      channels: channelSubs
        .filter((s) => s.userId === u.id)
        .filter((s) => !mutedFor(u.id, 'channel', s.channelId))
        .reduce((sum, s) => sum + channelUnread(s), 0),
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
          ...prefFields(u.id, 'chat', c.id),
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
    dropPrefs('chat', chat.id);
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
      pinned: pinPreview('chat', chat.id, visibleChatMessages(chat.id)),
    });
  },

  sendChatMessage: (chatId: number, text: string, replyTo?: number | null, forward?: ForwardRef, file?: AttachmentInput) => {
    const { u, chat } = requireChat(chatId);
    const src = forward ? forwardSource(forward, u) : null;
    const body = src ? src.body : text.trim();
    const attachment = src ? src.attachment : file ? attachmentFrom(file) : null;
    if (!body && !attachment) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (!src && replyTo != null && !visibleChatMessages(chat.id).some((m) => m.id === replyTo)) {
      fail(400, 'Сообщение, на которое вы отвечаете, не найдено');
    }

    const m: DbChatMessage = {
      id: id(), chatId: chat.id, authorId: u.id, body, createdAt: new Date().toISOString(),
      replyToId: src ? null : replyTo ?? null, editedAt: null, fwdUserId: src?.fwdUserId ?? null, fwdChannelId: src?.fwdChannelId ?? null, attachment,
    };
    chatMessages.push(m);
    clearTyping(`chat:${chat.id}`, u.id);

    for (const member of membersOf(chat.id)) {
      notify({ userId: member.userId, actorId: u.id, kind: 'chat_message', chatId: chat.id });
    }

    return tick({ message: toChatMessage(m) });
  },

  sendChatAttachment: (chatId: number, input: AttachmentInput) =>
    mockApi.sendChatMessage(chatId, input.body ?? '', input.replyTo ?? null, undefined, input),

  editChatMessage: (chatId: number, messageId: number, text: string) => {
    const { u, chat } = requireChat(chatId);
    const m = requireChatMessage(chat.id, messageId);
    assertEditable(m.authorId, m.createdAt, m.fwdUserId, u, m.fwdChannelId);
    const body = text.trim();
    if (!body && !m.attachment) fail(400, '«сообщение»: минимум 1 символов');
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
    if (pinnedOf('chat', chat.id)?.messageId === m.id) setPin('chat', chat.id, null);
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
    dropPrefs('chat', chat.id, person!.id);
    // Ушедшему события об этом чате больше некуда вести.
    notifications = notifications.filter((n) => !(n.userId === person!.id && n.chatId === chat.id));

    const rest = membersOf(chat.id);
    if (rest.length === 0) {
      chats = chats.filter((c) => c.id !== chat.id);
      dropPrefs('chat', chat.id);
      chatMessages = chatMessages.filter((m) => m.chatId !== chat.id);
      notifications = notifications.filter((n) => n.chatId !== chat.id);
    } else if (chat.ownerId === person!.id) {
      // Чат без владельца невозможно ни переименовать, ни распустить —
      // владение переходит участнику с самым ранним joined_at.
      chat.ownerId = rest[0].userId;
    }

    return leaving ? tick({ ok: true as const, left: true }) : tick({ ok: true as const });
  },

  // ─ Каналы ─────────────────────────────────────────────────────────────

  channels: () => {
    const u = requireMe()!;
    const list: ChannelSummary[] = channelSubs
      .filter((s) => s.userId === u.id)
      .map((s) => {
        const c = channels.find((x) => x.id === s.channelId)!;
        const last = postsOf(c.id).at(-1) ?? null;
        return {
          ...toChannel(c), unread: channelUnread(s), lastPost: last ? toChannelPost(last) : null,
          ...prefFields(u.id, 'channel', c.id),
        };
      })
      .sort((a, b) => (b.lastPost?.createdAt ?? b.createdAt).localeCompare(a.lastPost?.createdAt ?? a.createdAt));
    return tick({ channels: list, unreadTotal: list.reduce((sum, c) => sum + c.unread, 0) });
  },

  searchChannels: (q: string) => {
    requireMe();
    const needle = q.trim().toLowerCase().replace(/^@/, '').replace(/ё/g, 'е');
    if (needle.length < 2) return tick({ channels: [] as Channel[] });
    const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
    return tick({
      channels: channels
        .filter((c) => fold(c.title).includes(needle) || c.handle.includes(needle))
        .map(toChannel)
        .sort((a, b) => b.subscriberCount - a.subscriberCount),
    });
  },

  createChannel: (input: { title: string; handle: string; description: string }) => {
    const u = requireMe()!;
    const title = input.title.trim();
    const handle = input.handle.trim().toLowerCase().replace(/^@/, '');
    if (!title) fail(400, '«название канала»: минимум 1 символов');
    if (title.length > 60) fail(400, '«название канала»: максимум 60 символов');
    if (!CHANNEL_HANDLE_RE.test(handle)) fail(400, 'Адрес канала: 4–32 символа, латиница, цифры и _, начинается с буквы');
    if (handle === 'search') fail(400, 'Этот адрес зарезервирован');
    if (channelBy(handle)) fail(409, 'Этот адрес уже занят');
    const c: DbChannel = {
      id: id(), handle, title, description: input.description.trim().slice(0, 255), ownerId: u.id,
      createdAt: new Date().toISOString(),
    };
    channels.push(c);
    channelSubs.push({ channelId: c.id, userId: u.id, joinedAt: c.createdAt, lastReadId: 0 });
    return tick({ channel: toChannel(c) });
  },

  channel: (handle: string) => tick({ channel: toChannel(requireChannel(handle).c) }),

  updateChannel: (handle: string, input: { title?: string; description?: string }) => {
    const { c } = requireOwner(handle);
    if (input.title !== undefined) {
      if (!input.title.trim()) fail(400, '«название канала»: минимум 1 символов');
      c.title = input.title.trim().slice(0, 60);
    }
    if (input.description !== undefined) c.description = input.description.trim().slice(0, 255);
    return tick({ channel: toChannel(c) });
  },

  deleteChannel: (handle: string) => {
    const { u, c } = requireChannel(handle);
    if (c.ownerId !== u.id) fail(403, 'Удалить канал может только владелец');
    const ids = new Set(postsOf(c.id).map((p) => p.id));
    channels = channels.filter((x) => x.id !== c.id);
    dropPrefs('channel', c.id);
    channelSubs = channelSubs.filter((s) => s.channelId !== c.id);
    channelPosts = channelPosts.filter((p) => p.channelId !== c.id);
    channelViews = channelViews.filter((v) => !ids.has(v.postId));
    postReactions = postReactions.filter((r) => !ids.has(r.messageId));
    channelComments = channelComments.filter((x) => !ids.has(x.postId));
    return tick({ ok: true as const });
  },

  subscribe: (handle: string, on: boolean) => {
    const { u, c } = requireChannel(handle);
    if (on) {
      // Подписчик читает с этого места: старое — не «непрочитанное».
      const top = postsOf(c.id).at(-1)?.id ?? 0;
      if (!subOf(c.id, u.id)) channelSubs.push({ channelId: c.id, userId: u.id, joinedAt: new Date().toISOString(), lastReadId: top });
    } else {
      if (c.ownerId === u.id) fail(400, 'Владелец не может отписаться от своего канала');
      channelSubs = channelSubs.filter((s) => !(s.channelId === c.id && s.userId === u.id));
      dropPrefs('channel', c.id, u.id);
    }
    return tick({ channel: toChannel(c) });
  },

  markChannelRead: (handle: string) => {
    const { u, c } = requireChannel(handle);
    const s = subOf(c.id, u.id);
    if (s) s.lastReadId = postsOf(c.id).at(-1)?.id ?? 0;
    return tick({ ok: true as const });
  },

  channelPosts: (handle: string, cursor?: number | null) => {
    const { u, c } = requireChannel(handle);
    let list = postsOf(c.id);
    if (cursor != null) list = list.filter((p) => p.id < cursor);
    const page = list.slice(-20);
    // Просмотр — один на человека.
    for (const p of page) {
      if (!channelViews.some((v) => v.postId === p.id && v.userId === u.id)) channelViews.push({ postId: p.id, userId: u.id });
    }
    return tick({
      channel: toChannel(c),
      posts: page.map(toChannelPost),
      nextCursor: list.length > 20 ? page[0].id : null,
      pinned: pinPreview('channel', c.id, postsOf(c.id)),
    });
  },

  publish: (handle: string, input: { body: string } | AttachmentInput) => {
    const { u, c } = requireOwner(handle);
    const body = (input.body ?? '').trim();
    const attachment = 'file' in input ? attachmentFrom(input) : null;
    if (!body && !attachment) fail(400, '«публикация»: минимум 1 символов');
    if (body.length > 4000) fail(400, '«публикация»: максимум 4000 символов');
    const post: DbChannelPost = {
      id: id(), channelId: c.id, authorId: u.id, body, createdAt: new Date().toISOString(), editedAt: null, attachment,
    };
    channelPosts.push(post);
    const s = subOf(c.id, u.id);
    if (s) s.lastReadId = post.id;
    return tick({ post: toChannelPost(post) });
  },

  editPost: (handle: string, postId: number, text: string) => {
    const { c } = requireOwner(handle);
    const post = requirePost(c.id, postId);
    if (Date.now() - Date.parse(post.createdAt) > EDIT_WINDOW_MS) fail(403, 'Сообщение можно изменить только в течение 48 часов');
    const body = text.trim();
    if (!body && !post.attachment) fail(400, '«публикация»: минимум 1 символов');
    if (body !== post.body) {
      post.body = body;
      post.editedAt = new Date().toISOString();
    }
    return tick({ post: toChannelPost(post) });
  },

  deleteChannelPost: (handle: string, postId: number) => {
    const { c } = requireOwner(handle);
    const post = requirePost(c.id, postId);
    channelPosts = channelPosts.filter((p) => p.id !== post.id);
    if (pinnedOf('channel', c.id)?.messageId === post.id) setPin('channel', c.id, null);
    channelComments = channelComments.filter((x) => x.postId !== post.id);
    postReactions = postReactions.filter((r) => r.messageId !== post.id);
    return tick({ ok: true as const });
  },

  reactPost: (handle: string, postId: number, emoji: string | null) => {
    const { u, c } = requireChannel(handle);
    const post = requirePost(c.id, postId);
    setReaction(postReactions, post.id, u.id, emoji);
    return tick({ post: toChannelPost(post) });
  },

  channelComments: (handle: string, postId: number) => {
    const { u, c } = requireChannel(handle);
    const post = requirePost(c.id, postId);
    return tick({
      channel: toChannel(c),
      post: toChannelPost(post),
      comments: channelComments.filter((x) => x.postId === post.id && !hidden(x.authorId)).sort((a, b) => a.id - b.id).map(toChannelComment),
      canComment: !blockedPair(u.id, c.ownerId),
    });
  },

  addChannelComment: (handle: string, postId: number, text: string) => {
    const { u, c } = requireChannel(handle);
    const post = requirePost(c.id, postId);
    if (blockedPair(u.id, c.ownerId)) fail(403, 'Комментировать этот канал нельзя');
    const body = text.trim();
    if (!body) fail(400, '«комментарий»: минимум 1 символов');
    if (body.length > 1000) fail(400, '«комментарий»: максимум 1000 символов');
    const comment: DbChannelComment = { id: id(), postId: post.id, authorId: u.id, body, createdAt: new Date().toISOString() };
    channelComments.push(comment);
    return tick({ comment: toChannelComment(comment) });
  },

  deleteChannelComment: (handle: string, postId: number, commentId: number) => {
    const { u, c } = requireChannel(handle);
    const post = requirePost(c.id, postId);
    const comment = channelComments.find((x) => x.id === commentId && x.postId === post.id);
    if (!comment) fail(404, 'Комментарий не найден');
    if (comment!.authorId !== u.id && c.ownerId !== u.id) fail(403, 'Удалить можно только свой комментарий');
    channelComments = channelComments.filter((x) => x.id !== commentId);
    return tick({ ok: true as const });
  },

  // ─ Настройки чатов ────────────────────────────────────────────────────

  // ─ Поиск внутри переписки ─────────────────────────────────────────────

  searchThread: (username: string, q: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    const hits = findHits(q, pairThread(u.id, other!.id), (m) => m.fromId);
    return tick({ results: hits });
  },

  searchChat: (chatId: number, q: string) => {
    const { chat } = requireChat(chatId);
    return tick({ results: findHits(q, visibleChatMessages(chat.id), (m) => m.authorId) });
  },

  searchChannel: (handle: string, q: string) => {
    const { c } = requireChannel(handle);
    return tick({ results: findHits(q, postsOf(c.id), () => null) });
  },

  pinMessage: (username: string, messageId: number) => {
    const { u, other, m } = requirePairMessage(username, messageId);
    if (blockedPair(u.id, other.id)) fail(403, 'Переписка с этим пользователем недоступна');
    setPin('dm', pinScope(u.id, other.id), m.id);
    return tick({ pinned: pinPreview('dm', pinScope(u.id, other.id), pairThread(u.id, other.id)) });
  },

  unpinMessage: (username: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    setPin('dm', pinScope(u.id, other!.id), null);
    return tick({ ok: true as const });
  },

  pinChatMessage: (chatId: number, messageId: number) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Закреплять сообщения может только владелец чата');
    const m = requireChatMessage(chat.id, messageId);
    setPin('chat', chat.id, m.id);
    return tick({ pinned: pinPreview('chat', chat.id, visibleChatMessages(chat.id)) });
  },

  unpinChatMessage: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Откреплять сообщения может только владелец чата');
    setPin('chat', chat.id, null);
    return tick({ ok: true as const });
  },

  pinPost: (handle: string, postId: number) => {
    const { c } = requireOwner(handle);
    const post = requirePost(c.id, postId);
    setPin('channel', c.id, post.id);
    return tick({ pinned: pinPreview('channel', c.id, postsOf(c.id)) });
  },

  unpinPost: (handle: string) => {
    const { c } = requireOwner(handle);
    setPin('channel', c.id, null);
    return tick({ ok: true as const });
  },

  // ─ Аккаунт ─────────────────────────────────────────────────────────────

  account: () => {
    const u = requireMe()!;
    return tick({ email: u.email as string | null, lastSeen: u.lastSeenPrivacy ?? 'all', createdAt: u.createdAt });
  },

  setLastSeen: (lastSeen: LastSeenPrivacy) => {
    const u = requireMe()!;
    if (!['all', 'follows', 'nobody'].includes(lastSeen)) fail(400, '«Кто видит время захода» — all, follows, nobody');
    u.lastSeenPrivacy = lastSeen;
    return tick({ lastSeen });
  },

  changePassword: (currentPassword: string, newPassword: string) => {
    const u = requireMe()!;
    if (newPassword.length < 8) fail(400, 'Пароль должен быть не короче 8 символов');
    if (u.password !== currentPassword) fail(403, 'Пароль не подходит');
    if (newPassword === currentPassword) fail(400, 'Новый пароль совпадает с текущим');
    u.password = newPassword;
    resets = resets.filter((r) => !(r.userId === u.id && !r.usedAt));
    return tick({ ok: true as const, ended: endOtherSessions(u.id) });
  },

  sessions: () => {
    const u = requireMe()!;
    const list = sessions
      .filter((s) => s.userId === u.id)
      .map((s) => ({ id: s.id, current: s.id === currentSession, createdAt: s.createdAt, userAgent: s.userAgent }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt));
    return tick({ sessions: list });
  },

  endSession: (sessionId: number) => {
    const u = requireMe()!;
    const s = sessions.find((x) => x.id === sessionId && x.userId === u.id);
    if (!s) fail(404, 'Сеанс не найден');
    if (s!.id === currentSession) fail(400, 'Это текущий сеанс — чтобы его закончить, нажмите «Выйти»');
    sessions = sessions.filter((x) => x !== s);
    return tick({ ok: true as const });
  },

  endOtherSessions: () => {
    const u = requireMe()!;
    return tick({ ok: true as const, ended: endOtherSessions(u.id) });
  },

  deleteAccount: (password: string) => {
    const u = requireMe()!;
    if (u.password !== password) fail(403, 'Пароль не подходит');
    dropUser(u.id);
    meId = null;
    currentSession = null;
    return tick({ ok: true as const });
  },

  // ─ Папки чатов ────────────────────────────────────────────────────────

  folders: () => {
    const u = requireMe()!;
    return tick({ folders: myFolders(u.id) });
  },

  createFolder: (input: FolderInput) => {
    const u = requireMe()!;
    if (myFolders(u.id).length >= 10) fail(400, 'Папок не больше 10');
    const f: DbFolder = { id: id(), userId: u.id, ...checkFolder(input, null) };
    folders.push(f);
    return tick({ folder: toFolder(f) });
  },

  updateFolder: (folderId: number, input: FolderInput) => {
    const u = requireMe()!;
    const f = folders.find((x) => x.id === folderId && x.userId === u.id);
    if (!f) fail(404, 'Папка не найдена');
    Object.assign(f!, checkFolder(input, f!));
    return tick({ folder: toFolder(f!) });
  },

  deleteFolder: (folderId: number) => {
    const u = requireMe()!;
    if (!folders.some((x) => x.id === folderId && x.userId === u.id)) fail(404, 'Папка не найдена');
    folders = folders.filter((x) => x.id !== folderId);
    return tick({ ok: true as const });
  },

  reorderFolders: (ids: number[]) => {
    const u = requireMe()!;
    const mine = myFolders(u.id).map((f) => f.id);
    if (ids.length !== mine.length || [...ids].sort().join() !== [...mine].sort().join()) {
      fail(400, 'Порядок — полный список ваших папок');
    }
    const others = folders.filter((f) => f.userId !== u.id);
    folders = [...others, ...ids.map((fid) => folders.find((f) => f.id === fid)!)];
    return tick({ folders: myFolders(u.id) });
  },

  setPref: (kind: PrefKind, target: string | number, input: { pinned?: boolean; muted?: boolean }) => {
    const u = requireMe()!;
    let targetId: number | null = null;
    if (kind === 'dm') {
      const other = byName(String(target));
      targetId = other?.id ?? null;
    } else if (kind === 'chat') {
      targetId = memberRow(Number(target), u.id) ? Number(target) : null;
    } else {
      const c = channelBy(String(target));
      targetId = c && subOf(c.id, u.id) ? c.id : null;
    }
    if (targetId == null) fail(404, 'Чат не найден');

    const current = prefOf(u.id, kind, targetId!);
    if (input.pinned && !current?.pinnedAt && prefs.filter((x) => x.userId === u.id && x.pinnedAt).length >= 5) {
      fail(400, 'Закрепить можно не больше 5 чатов');
    }
    const pinnedAt = input.pinned === undefined
      ? current?.pinnedAt ?? null
      : input.pinned ? current?.pinnedAt ?? new Date().toISOString() : null;
    const muted = input.muted === undefined ? Boolean(current?.muted) : input.muted;

    prefs = prefs.filter((x) => x !== current);
    if (pinnedAt || muted) prefs.push({ userId: u.id, kind, targetId: targetId!, pinnedAt, muted });
    return tick({ pinned: Boolean(pinnedAt), muted });
  },
});
