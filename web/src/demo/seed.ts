import { type Attachment, type Media, type NotificationKind } from '../api';
import { type DbUser, type DbPost, type DbComment, type DbChannel, type DbChannelPost, type DbMessage, type DbChat, NO_EXTRAS, type DbChatMessage, type DbPoll, db, typingUntil, id, ago, days } from './store';
import { gradient, hummedVoice, paintedVideoNote } from './media';
import { openSession } from './model/account';

/** Засев витрины: люди, записи, переписки, группа, каналы — состояние на момент открытия. */

export function seed() {
  db.users = [];
  db.posts = [];
  db.comments = [];
  db.likes = [];
  db.follows = [];
  db.messages = [];
  db.resets = [];
  db.notifications = [];
  db.blocks = [];
  db.followRequests = [];
  db.scheduledPosts = [];
  db.postViews = [];
  db.postDrafts = [];
  db.bookmarks = [];
  db.reports = [];
  db.chats = [];
  db.chatMembers = [];
  db.chatMessages = [];
  db.dmReactions = [];
  db.chatReactions = [];
  db.chatMentions = [];
  db.polls = [];
  db.pollVotes = [];
  db.scheduledMessages = [];
  db.channels = [];
  db.channelSubs = [];
  db.channelPosts = [];
  db.channelViews = [];
  db.postReactions = [];
  db.prefs = [];
  db.drafts = [];
  db.pins = [];
  db.folders = [];
  db.sessions = [];
  db.currentSession = null;
  db.phoneCodes = [];
  db.phoneTickets = [];
  db.usernameHolds = [];
  db.dmSettings = [];
  db.channelComments = [];
  typingUntil.clear();
  db.nextId = 1;

  const make = (username: string, displayName: string, bio: string, avatar: string | null): DbUser => {
    const u: DbUser = {
      id: id(), username, displayName, bio, avatarUrl: avatar,
      createdAt: ago(days(280)), email: `${username}@example.test`, password: 'parol12345',
      lastSeenAt: null,
    };
    db.users.push(u);
    return u;
  };

  const demo = make('demo', 'Ерлан', 'Собираю портфолио и пишу о том, что строю.', gradient('#0e7863', '#8265ba', 256, 256));
  // Старый аккаунт с привязанным номером: в витрине можно войти и по логину,
  // и по номеру — вторым шагом тогда спросят пароль.
  demo.phone = '+996555000001';
  const marina = make('marina', 'Марина Штольц', 'Читаю больше, чем успеваю обдумывать.', gradient('#8265ba', '#3b7a9c', 256, 256));
  const oleg = make('oleg_k', 'Олег Кузьмин', 'Чиню станки старше себя.', gradient('#ad5f34', '#488048', 256, 256));
  const nina = make('nina', 'Нина Барто', 'Поля, плёнка, проявка на кухне.', null);

  // Номера для поиска по телефону: Марину находят все, а номер её видят
  // только те, на кого она подписана; Олега по номеру находят его подписки.
  marina.phone = '+996555000002';
  marina.phoneFind = 'all';
  marina.phoneShow = 'follows';
  oleg.phone = '+996555000003';
  oleg.phoneFind = 'follows';

  // Три разных «в сети», чтобы в витрине было видно все подписи сразу.
  marina.alwaysOnline = true;
  oleg.lastSeenAt = ago(25);
  nina.lastSeenAt = ago(days(1) + 180);

  const post = (author: DbUser, body: string, minutes: number, media: Media | null = null) => {
    const p: DbPost = { id: id(), authorId: author.id, body, createdAt: ago(minutes), media };
    db.posts.push(p);
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

  db.likes.push({ userId: demo.id, postId: p1.id }, { userId: oleg.id, postId: p1.id }, { userId: nina.id, postId: p1.id });
  db.likes.push({ userId: marina.id, postId: p2.id });
  db.likes.push({ userId: demo.id, postId: p3.id }, { userId: marina.id, postId: p3.id });
  db.likes.push({ userId: marina.id, postId: p4.id });
  db.likes.push({ userId: demo.id, postId: op1.id }, { userId: marina.id, postId: op6.id });

  // Закладки витрины: сохранены в этом порядке, значит наверху списка будет
  // последняя строка. Закладка на чужую запись уведомления не создаёт.
  const save = (target: DbPost, minutes: number) => {
    db.bookmarks.push({ id: id(), userId: demo.id, postId: target.id, createdAt: ago(minutes) });
  };
  save(op3, days(110));
  save(op6, days(58));
  save(p1, 6);

  const answer = (post: DbPost, from: DbUser, body: string, minutes: number): DbComment => {
    const c: DbComment = { id: id(), postId: post.id, authorId: from.id, body, createdAt: ago(minutes) };
    db.comments.push(c);
    return c;
  };

  answer(p1, oleg, 'А какое издание? Мне попадалось только женское.', 10);
  answer(p1, marina, 'Мужское. Разница в одном абзаце, но он переворачивает финал.', 8);
  answer(p3, marina, 'Плёнка? Цвет совсем не цифровой.', 100);
  const c4 = answer(p4, oleg, 'Сколько ушло на первую версию? И почему без ORM — принципиально или просто не понадобилась?', 39);

  db.follows.push(
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
    db.messages.push(m);
    return m;
  };

  dm(marina, demo, 'Слушай, ты был на той выставке в подвале на Гоголя?', 90);
  dm(demo, marina, 'Был, но не досмотрел — закрывались. Успел только первый зал.', 88);
  dm(marina, demo, 'Второй там и был весь смысл. Они его специально спрятали за лестницей.', 86);
  const weekend = dm(demo, marina, 'Тогда схожу ещё раз. В выходные?', 84);
  // Ответ с цитатой и реакция — чтобы в витрине всё это было видно сразу.
  dm(marina, demo, 'Давай в субботу до обеда, пока пусто.', 82, true, weekend);
  const hi = dm(marina, demo, '', 81.5);
  hi.sticker = 'plenka/yay';
  const hum = hummedVoice(6);
  const voice = dm(marina, demo, '', 81);
  voice.attachment = { url: hum.url, kind: 'voice', mime: 'audio/wav', name: null, size: null, duration: 6, wave: hum.wave };
  const note = dm(marina, demo, '', 80);
  note.attachment = { url: '', kind: 'videonote', mime: 'video/webm', name: null, size: null, duration: 4, wave: null };
  // Видео дорисуется через пару секунд — запись холста асинхронна. До тех пор
  // «кружок» пустой; не умеет браузер записывать холст — сообщения не будет.
  void paintedVideoNote(4).then((url) => {
    if (url) note.attachment = { ...note.attachment!, url };
    else db.messages = db.messages.filter((m) => m.id !== note.id);
  });
  db.dmReactions.push({ messageId: weekend.id, userId: marina.id, emoji: '❤️', createdAt: ago(82) });
  // Записи о звонках — звонков в витрине нет, но как они выглядят, видно.
  dm(demo, oleg, '', 60).call = { video: false, outcome: 'ended', duration: 192 };
  dm(oleg, demo, '', 45).call = { video: true, outcome: 'missed', duration: null };
  dm(oleg, demo, 'Привет! Нашёл тот станок с фотографии — расскажу при встрече.', 30, false);
  dm(oleg, demo, 'И ещё: у тебя тот аккорд из поста — это Am7?', 25, false);

  // Групповой чат: владелец — тот, кем входят в витрину, иначе в панели
  // участников не видно ни переименования, ни удаления.
  const room: DbChat = { id: id(), title: 'Плёнка и проявка', ownerId: demo.id, createdAt: ago(75) };
  db.chats.push(room);

  const join = (u: DbUser, minutes: number) => {
    db.chatMembers.push({ chatId: room.id, userId: u.id, joinedAt: ago(minutes), lastReadId: 0 });
  };
  join(demo, 75);
  join(nina, 75);
  join(marina, 74);

  const say = (from: DbUser, body: string, minutes: number, replyTo: DbChatMessage | null = null): DbChatMessage => {
    const m: DbChatMessage = {
      id: id(), chatId: room.id, authorId: from.id, body, createdAt: ago(minutes), ...NO_EXTRAS, replyToId: replyTo?.id ?? null,
    };
    db.chatMessages.push(m);
    return m;
  };

  const invite = say(nina, 'Проявляем в субботу у меня? Бачок на две плёнки есть, проявителя хватит на четыре.', 70);
  db.pins.push({ kind: 'chat', scope: String(room.id), messageId: invite.id });
  const tank = say(nina, 'Вот он, кстати.', 68);
  tank.attachment = {
    url: gradient('#3b7a9c', '#e08a4a', 720, 480, 'бачок и две плёнки'),
    kind: 'image', mime: 'image/svg+xml', name: 'bachok.jpg', size: null, duration: null, wave: null,
  };
  const mine = say(demo, 'Давайте. Принесу вторую плёнку и таймер, а то в прошлый раз считали вслух.', 65);
  const last = say(marina, '@demo, я приду с камерой деда — она пролежала на антресолях лет десять, надо проверить затвор.', 59, invite);
  db.chatMentions.push({ messageId: last.id, userId: demo.id });
  const film = say(nina, 'Какую плёнку берём на субботу?', 57);
  const filmPoll: DbPoll = {
    id: id(), kind: 'chat', messageId: film.id, multiple: false, anonymous: false, closedAt: null,
    options: [{ id: id(), text: 'Kodak Gold 200' }, { id: id(), text: 'Ilford HP5' }, { id: id(), text: 'Fomapan 100' }],
  };
  db.polls.push(filmPoll);
  db.pollVotes.push(
    { pollId: filmPoll.id, optionId: filmPoll.options[1].id, userId: marina.id, createdAt: ago(56) },
    { pollId: filmPoll.id, optionId: filmPoll.options[1].id, userId: nina.id, createdAt: ago(56) },
  );
  db.chatReactions.push(
    { messageId: mine.id, userId: nina.id, emoji: '👍', createdAt: ago(64) },
    { messageId: mine.id, userId: marina.id, emoji: '👍', createdAt: ago(60) },
    { messageId: last.id, userId: nina.id, emoji: '🔥', createdAt: ago(58) },
  );

  // Ватерлиния: у нас прочитано всё до своей реплики — реплика Марины остаётся
  // непрочитанной и даёт единицу в счётчике. У остальных прочитано всё, но по
  // фактическому id, а не «бесконечности»: иначе новые сообщения не были бы
  // непрочитанными и для них, если войти в витрину под их именем.
  for (const m of db.chatMembers) m.lastReadId = m.userId === demo.id ? mine.id : last.id;

  const event = (
    actor: DbUser,
    kind: NotificationKind,
    minutes: number,
    read: boolean,
    refs: { postId?: number; commentId?: number; chatId?: number; messageId?: number; device?: string } = {},
  ) => {
    db.notifications.push({
      id: id(), userId: demo.id, actorId: actor.id, kind,
      postId: refs.postId ?? null, commentId: refs.commentId ?? null, chatId: refs.chatId ?? null,
      messageId: refs.messageId ?? null, device: refs.device ?? null,
      createdAt: ago(minutes), readAt: read ? ago(minutes - 1) : null,
    });
  };

  // Четыре вида событий и три непрочитанных — ровно то состояние, которое
  // описывают счётчики в сайдбаре витрины: 2 письма, 1 чат, 3 события.
  event(demo, 'new_login', 60 * 26, true, { device: 'Safari, iPhone' });
  event(marina, 'like', 190, true, { postId: p4.id });
  event(marina, 'mention', 59, false, { chatId: room.id, messageId: last.id });
  event(oleg, 'comment', 39, false, { postId: p4.id, commentId: c4.id });
  event(oleg, 'message', 25, false);

  // Каналы. Канал Нины — чужой, на него подписан смотрящий, и последняя
  // публикация у него не прочитана. «Хроника изнутри» — свой: в нём витрина
  // даёт опубликовать самому.
  const channel = (owner: DbUser, handle: string, title: string, description: string, minutes: number) => {
    const c: DbChannel = { id: id(), handle, title, description, ownerId: owner.id, createdAt: ago(minutes) };
    db.channels.push(c);
    db.channelSubs.push({ channelId: c.id, userId: owner.id, joinedAt: c.createdAt, lastReadId: 0 });
    return c;
  };
  const publish = (c: DbChannel, body: string, minutes: number, attachment: Attachment | null = null) => {
    const post: DbChannelPost = {
      id: id(), channelId: c.id, authorId: c.ownerId, body, createdAt: ago(minutes), editedAt: null, attachment,
    };
    db.channelPosts.push(post);
    return post;
  };
  const sub = (c: DbChannel, u: DbUser, lastReadId: number) =>
    db.channelSubs.push({ channelId: c.id, userId: u.id, joinedAt: c.createdAt, lastReadId });
  const saw = (post: DbChannelPost, ...who: DbUser[]) => who.forEach((u) => db.channelViews.push({ postId: post.id, userId: u.id }));

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
  db.postReactions.push(
    { messageId: n1.id, userId: marina.id, emoji: '❤️', createdAt: ago(days(19)) },
    { messageId: n1.id, userId: demo.id, emoji: '❤️', createdAt: ago(days(19)) },
    { messageId: n2.id, userId: oleg.id, emoji: '🔥', createdAt: ago(days(5)) },
  );
  db.channelComments.push(
    { id: id(), postId: n1.id, authorId: oleg.id, body: 'А какой проявитель берёшь?', createdAt: ago(days(19)) },
    { id: id(), postId: n1.id, authorId: nina.id, body: 'Родинал, 1+50 — он прощает почти всё.', createdAt: ago(days(19) - 30) },
  );

  const dev = channel(demo, 'chronika_dev', 'Хроника изнутри', 'Как устроен этот сайт: решения, ошибки и то, что пришлось переделывать.', days(10));
  db.pins.push({ kind: 'channel', scope: String(notes.id), messageId: n1.id });
  db.folders.push(
    { id: id(), userId: demo.id, title: 'Личное', types: ['dm'], include: [], exclude: [], excludeMuted: false, excludeRead: false },
    {
      id: id(), userId: demo.id, title: 'Плёнка', types: [],
      include: [{ kind: 'chat', id: room.id }, { kind: 'channel', id: notes.id }],
      exclude: [], excludeMuted: false, excludeRead: false,
    },
  );
  const d1 = publish(dev, 'Здесь пишу о том, как устроена «Хроника» изнутри. Первое: сообщения ходят опросом раз в три секунды, без WebSocket, — и этого хватает.', days(9));
  db.channelSubs.find((s) => s.channelId === dev.id && s.userId === demo.id)!.lastReadId = d1.id;
  sub(dev, marina, d1.id);
  sub(dev, oleg, d1.id);
  saw(d1, demo, marina, oleg);

  db.prefs.push(
    { userId: demo.id, kind: 'dm', targetId: marina.id, pinnedAt: ago(days(3)), muted: false },
    { userId: demo.id, kind: 'dm', targetId: oleg.id, pinnedAt: null, muted: true },
  );
  // Событие от приглушённого Олега в «Событиях» не появилось бы — убираем.
  db.notifications = db.notifications.filter((n) => !(n.kind === 'message' && n.actorId === oleg.id));

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  db.scheduledMessages.push({
    id: id(), userId: demo.id, kind: 'dm', targetId: marina.id,
    body: 'Доброе утро! Не забудь плёнку — встречаемся в одиннадцать у Литейной.',
    sendAt: tomorrow.toISOString(), createdAt: ago(30),
  });

  // «Избранное»: заметка себе и пересланная реплика Марины.
  dm(demo, demo, 'Исходники «Хроники»: https://github.com/erlan4761/Social-site', days(3));
  dm(demo, demo, 'Список на субботу: две плёнки Kodak Gold 200, фиксаж, забрать сканы с Литейной.', days(2));
  const kept = dm(demo, demo, 'Второй там и был весь смысл. Они его специально спрятали за лестницей.', 85);
  kept.fwdUserId = marina.id;

  db.sessions.push(
    { id: id(), userId: demo.id, createdAt: ago(days(20)), lastUsedAt: ago(days(10)), userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' },
    { id: id(), userId: demo.id, createdAt: ago(days(4)), lastUsedAt: ago(120), userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  );
  // Смотрящий витрины — модератор: в «Жалобах» лежат две жалобы на снимок Нины.
  demo.moderator = true;
  db.reports.push(
    { reporterId: marina.id, targetType: 'post', targetId: op1.id, reason: 'other', note: 'Кажется, это чужой снимок', createdAt: ago(300) },
    { reporterId: oleg.id, targetType: 'post', targetId: op1.id, reason: 'other', note: '', createdAt: ago(120) },
  );

  // Недописанный ответ Олегу — в списке чатов видно «Черновик: …».
  db.drafts.push({ userId: demo.id, kind: 'dm', targetId: oleg.id, body: 'Да, Am7 — а станок какого года?', updatedAt: ago(20) });
  openSession(demo.id);

  db.meId = demo.id;
}
