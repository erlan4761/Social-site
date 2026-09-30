import { type LastSeenPrivacy, type Privacy, type User } from '../../api';
import { deviceName } from '../../device';
import { type DbUser, db, id, tick, fail } from '../store';
import { openSession, endOtherSessions, dropUser } from '../model/account';
import { byId, byName, byEmail, me, requireMe } from '../model/people';
import { publicUser } from '../model/posts';
import { notifyLogin } from '../model/notifications';
import { checkCode, dropTicket, issueTicket, normalizePhone, readTicket, sendCode } from '../model/phone';
import type { PhoneVerdict, TwoFactorNeeded } from '../../api';
import {
  backupCodesLeft, dropTwoFactorTicket, failTwoFactorTicket, issueBackupCodes, issueTwoFactorTicket, matchTotp, newSecret,
  otpauthUri, readTwoFactorTicket, twoFactorOn, useSecondFactor,
} from '../model/twoFactor';

const twoFactorStep = (userId: number): TwoFactorNeeded => ({ status: 'two-factor', ticket: issueTwoFactorTicket(userId) });
const WRONG_CODE = 'Код не подходит — проверьте, что время на телефоне точное';

/** Методы витрины: вход, регистрация, пароль, настройки аккаунта. */

/** Старый логин две недели закреплён за прежним владельцем — как usernames.js. */
const HOLD_DAYS = 14;
const usernameTaken = (name: string, forUserId: number | null = null) =>
  db.users.some((x) => x.username === name && x.id !== forUserId)
  || db.usernameHolds.some((h) => h.username === name && h.until > Date.now() && h.userId !== forUserId);

/** Запросы входа по QR — в памяти вкладки, как в памяти процесса на сервере. */
const qrRequests = new Map<string, { token: string; code: string; secret: string; until: number; approvedBy: number | null }>();
const findQr = (key: string) => {
  const norm = key.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const r = qrRequests.get(key) ?? [...qrRequests.values()].find((x) => x.code === norm);
  return r && r.until > Date.now() ? r : null;
};

const PRIVACY_KEYS = ['lastSeen', 'phoneFind', 'phoneShow'] as const;
const OPTIONS: LastSeenPrivacy[] = ['all', 'follows', 'nobody'];

export const authApi = {
  // Пуш-уведомлений у витрины нет: их доставляет сервер, а его здесь нет.
  pushKey: () => fail(400, 'В витрине пуш-уведомлений нет — они приходят от сервера'),
  savePushSubscription: (_subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    fail(400, 'В витрине пуш-уведомлений нет — они приходят от сервера'),
  deletePushSubscription: (_endpoint: string) => tick({ ok: true as const }),

  // ─ Вход по QR: в одной вкладке компьютер и телефон — это одно и то же, но
  // сами правила (одноразовость, код, подтверждение) — как на сервере.
  qrLoginStart: () => {
    if (me()) fail(400, 'Вы уже вошли');
    const code = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    const r = { token: crypto.randomUUID().replace(/-/g, '').slice(0, 22), code, secret: crypto.randomUUID(), until: Date.now() + 120_000, approvedBy: null as number | null };
    qrRequests.set(r.token, r);
    return tick({ token: r.token, code: r.code, secret: r.secret, expiresIn: 120 });
  },

  qrLoginPoll: (token: string, secret: string): Promise<{ status: 'pending' } | { status: 'approved'; user: User }> => {
    const r = qrRequests.get(token);
    if (!r || r.secret !== secret || r.until < Date.now()) fail(410, 'Код устарел');
    if (!r!.approvedBy) return tick({ status: 'pending' as const });
    qrRequests.delete(token);
    db.meId = r!.approvedBy;
    openSession(r!.approvedBy);
    return tick({ status: 'approved' as const, user: publicUser(byId(r!.approvedBy)!) });
  },

  qrInfo: (key: string) => {
    requireMe();
    const r = findQr(key);
    if (!r || r.approvedBy) fail(404, 'Код устарел или уже использован — обновите его на компьютере');
    return tick({ device: deviceName(typeof navigator === 'undefined' ? null : navigator.userAgent), expiresIn: Math.round((r!.until - Date.now()) / 1000) });
  },

  qrApprove: (by: { token: string } | { code: string }) => {
    const u = requireMe()!;
    const r = findQr('token' in by ? by.token : by.code);
    if (!r || r.approvedBy) fail(404, 'Код устарел или уже использован — обновите его на компьютере');
    r!.approvedBy = u.id;
    return tick({ ok: true as const, device: deviceName(typeof navigator === 'undefined' ? null : navigator.userAgent) });
  },

  // Своё «я» — с флагом модератора, как /auth/me на сервере.
  me: () => tick({ user: me() ? { ...publicUser(me()!), ...(me()!.moderator ? { moderator: true } : {}) } : null }),

  // ─ Вход по номеру ─────────────────────────────────────────────────

  phoneStart: (raw: string) => tick(sendCode(normalizePhone(raw), 'login')),

  phoneVerify: (raw: string, code: string) => {
    const phone = normalizePhone(raw);
    checkCode(phone, 'login', code);
    const u = db.users.find((x) => x.phone === phone);
    let verdict: PhoneVerdict;
    if (!u) verdict = { status: 'signup', ticket: issueTicket('signup', phone) };
    else if (u.password) verdict = { status: 'password', ticket: issueTicket('password', phone, u.id) };
    else if (twoFactorOn(u)) verdict = twoFactorStep(u.id);
    else {
      db.meId = u.id;
      openSession(u.id);
      notifyLogin(u.id);
      verdict = { status: 'signed-in', user: publicUser(u) };
    }
    return tick(verdict);
  },

  phonePassword: (token: string, password: string) => {
    const ticket = readTicket(token, 'password');
    const u = byId(ticket.userId ?? -1);
    if (!u || !password || u.password !== password) {
      ticket.attempts += 1;
      if (ticket.attempts >= 5) dropTicket(ticket.token);
      fail(403, 'Пароль не подходит');
    }
    dropTicket(ticket.token);
    if (twoFactorOn(u)) return tick(twoFactorStep(u!.id));
    db.meId = u!.id;
    openSession(u!.id);
    notifyLogin(u!.id);
    return tick({ status: 'signed-in' as const, user: publicUser(u!) });
  },

  twoFactorLogin: (token: string, code: string) => {
    const ticket = readTwoFactorTicket(token);
    const u = byId(ticket.userId);
    const how = u && twoFactorOn(u) ? useSecondFactor(u, code) : null;
    if (!how) {
      failTwoFactorTicket(token);
      fail(403, 'Код не подходит');
    }
    dropTwoFactorTicket(token);
    if (u!.bannedAt) fail(403, 'Аккаунт заблокирован модератором');
    db.meId = u!.id;
    openSession(u!.id);
    notifyLogin(u!.id);
    return tick({ user: publicUser(u!), ...(how === 'backup' ? { backupCodesLeft: backupCodesLeft(u!) } : {}) });
  },

  twoFactorSetup: (password?: string) => {
    const u = requireMe()!;
    if (twoFactorOn(u)) fail(400, 'Вход с кодом уже включён');
    if (u.password && u.password !== password) fail(403, 'Пароль не подходит');
    u.totpPending = newSecret();
    return tick({ secret: u.totpPending, uri: otpauthUri(u.username, u.totpPending) });
  },

  twoFactorEnable: (code: string) => {
    const u = requireMe()!;
    if (twoFactorOn(u)) fail(400, 'Вход с кодом уже включён');
    if (!u.totpPending) fail(400, 'Сначала получите новый секрет');
    const step = matchTotp(u.totpPending!, code);
    if (step == null) fail(403, WRONG_CODE);
    u.totpSecret = u.totpPending;
    u.totpPending = null;
    u.totpEnabledAt = new Date().toISOString();
    u.totpLastStep = step;
    return tick({ backupCodes: issueBackupCodes(u) });
  },

  twoFactorDisable: (password: string | undefined, code: string) => {
    const u = requireMe()!;
    if (!twoFactorOn(u)) fail(400, 'Вход с кодом и так выключен');
    if (u.password && u.password !== password) fail(403, 'Пароль не подходит');
    if (!useSecondFactor(u, code)) fail(403, WRONG_CODE);
    u.totpSecret = null;
    u.totpPending = null;
    u.totpEnabledAt = null;
    u.totpLastStep = null;
    u.backupCodes = [];
    return tick({ ok: true as const });
  },

  twoFactorBackupCodes: (code: string) => {
    const u = requireMe()!;
    if (!twoFactorOn(u)) fail(400, 'Вход с кодом выключен');
    if (!useSecondFactor(u, code)) fail(403, WRONG_CODE);
    return tick({ backupCodes: issueBackupCodes(u) });
  },

  phoneSignup: (token: string, rawName: string, displayName: string, findable = false) => {
    const ticket = readTicket(token, 'signup');
    const username = rawName.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) fail(400, 'Имя пользователя: 3–20 символов, только латиница, цифры и _');
    if (usernameTaken(username)) fail(409, 'Это имя пользователя уже занято');
    if (db.users.some((x) => x.phone === ticket.phone)) {
      dropTicket(ticket.token);
      fail(409, 'Этот номер уже зарегистрирован — войдите по нему заново');
    }
    const u: DbUser = {
      id: id(), username, displayName: displayName.trim() || username,
      bio: '', avatarUrl: null, createdAt: new Date().toISOString(), email: null, password: '',
      phone: ticket.phone, passwordLogin: false, lastSeenAt: new Date().toISOString(),
      phoneFind: findable ? 'all' : 'nobody',
    };
    db.users.push(u);
    dropTicket(ticket.token);
    db.meId = u.id;
    openSession(u.id);
    return tick({ user: publicUser(u) });
  },

  login: (input: { username: string; password: string }): Promise<{ user: User; status?: undefined } | TwoFactorNeeded> => {
    const u = byName(input.username.trim());
    // Аккаунт по номеру по логину не входит: его пароль — второй шаг после кода.
    if (!u || u.passwordLogin === false || !u.password || u.password !== input.password) {
      fail(401, 'Неверное имя пользователя или пароль');
    }
    if (u!.bannedAt) fail(403, 'Аккаунт заблокирован модератором');
    if (twoFactorOn(u!)) return tick(twoFactorStep(u!.id));
    db.meId = u!.id;
    openSession(u!.id);
    notifyLogin(u!.id);
    return tick({ user: publicUser(u!) });
  },

  logout: () => {
    db.sessions = db.sessions.filter((s) => s.id !== db.currentSession);
    db.currentSession = null;
    db.meId = null;
    return tick({ ok: true as const });
  },

  forgotPassword: (rawEmail: string) => {
    const mail = rawEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) fail(400, 'Некорректный email');

    const user = byEmail(mail);
    const message = 'Если такой email зарегистрирован, на него отправлена ссылка';

    let demoLink: string | undefined;
    if (user) {
      db.resets = db.resets.filter((r) => !(r.userId === user.id && !r.usedAt));
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      db.resets.push({ token, userId: user.id, expiresAt: Date.now() + 30 * 60_000, usedAt: null });
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
    const r = db.resets.find((x) => x.token === token);
    const valid = Boolean(r && !r.usedAt && r.expiresAt > Date.now());
    return tick({ valid });
  },

  resetPassword: (token: string, password: string) => {
    if (password.length < 8) fail(400, 'Пароль должен быть не короче 8 символов');
    const r = db.resets.find((x) => x.token === token);
    if (!r || r.usedAt || r.expiresAt <= Date.now()) {
      fail(400, 'Ссылка недействительна или уже использована');
    }
    const user = byId(r!.userId)!;
    user.password = password;
    r!.usedAt = Date.now();
    if (db.meId === user.id) db.meId = null; // как и на бэкенде — сброс гасит текущую сессию
    return tick({ ok: true as const });
  },

  // ─ Аккаунт ─────────────────────────────────────────────────────────────

  account: () => {
    const u = requireMe()!;
    return tick({
      email: u.email ?? null,
      phone: u.phone ?? null,
      hasPassword: Boolean(u.password),
      passwordLogin: u.passwordLogin !== false,
      lastSeen: u.lastSeenPrivacy ?? 'all',
      phoneFind: u.phoneFind ?? 'nobody',
      phoneShow: u.phoneShow ?? 'nobody',
      createdAt: u.createdAt,
      twoFactor: twoFactorOn(u) ? { enabled: true, backupCodesLeft: backupCodesLeft(u) } : { enabled: false },
    });
  },

  linkPhoneStart: (raw: string) => {
    const u = requireMe()!;
    const phone = normalizePhone(raw);
    const owner = db.users.find((x) => x.phone === phone);
    if (owner?.id === u.id) fail(400, 'Это уже ваш номер');
    if (owner) fail(409, 'Этот номер привязан к другому аккаунту');
    return tick(sendCode(phone, 'link', u.id));
  },

  linkPhone: (raw: string, code: string) => {
    const u = requireMe()!;
    const phone = normalizePhone(raw);
    checkCode(phone, 'link', code, u.id);
    if (db.users.some((x) => x.phone === phone && x.id !== u.id)) fail(409, 'Этот номер привязан к другому аккаунту');
    u.phone = phone;
    return tick({ phone });
  },

  unlinkPhone: () => {
    const u = requireMe()!;
    if (u.passwordLogin === false) fail(400, 'Номер — ваш способ входа: его можно сменить, но не убрать');
    u.phone = null;
    return tick({ phone: null });
  },

  removePassword: (currentPassword: string) => {
    const u = requireMe()!;
    if (u.passwordLogin !== false) fail(400, 'Пароль нужен для входа по логину — убрать его нельзя');
    if (!u.password) fail(400, 'Пароля и так нет');
    if (u.password !== currentPassword) fail(403, 'Пароль не подходит');
    u.password = '';
    return tick({ ok: true as const });
  },

  deleteCode: () => {
    const u = requireMe()!;
    if (u.password) fail(400, 'Удаление подтверждается паролем');
    if (!u.phone) fail(400, 'Нет ни пароля, ни номера — удаление подтвердить нечем');
    return tick(sendCode(u.phone!, 'delete', u.id));
  },

  /** Выгрузка в витрине — из памяти вкладки, в том же формате, что на сервере. */
  exportData: () => {
    const u = requireMe()!;
    const nameOf = (uid: number) => byId(uid)?.username ?? null;
    const convs = new Map<number, { with: string | null; messages: unknown[] }>();
    for (const m of db.messages.filter((x) => x.fromId === u.id || x.toId === u.id)) {
      const other = m.fromId === u.id ? m.toId : m.fromId;
      if (!convs.has(other)) convs.set(other, { with: nameOf(other), messages: [] });
      convs.get(other)!.messages.push({ id: m.id, from: m.fromId === u.id ? 'me' : nameOf(m.fromId), body: m.body, createdAt: m.createdAt });
    }
    return tick({
      format: 'hronika-export/1',
      exportedAt: new Date().toISOString(),
      profile: { username: u.username, displayName: u.displayName, bio: u.bio, email: u.email, phone: u.phone ?? null, createdAt: u.createdAt },
      posts: db.posts.filter((x) => x.authorId === u.id).map((x) => ({ id: x.id, body: x.body, createdAt: x.createdAt })),
      comments: db.comments.filter((x) => x.authorId === u.id).map((x) => ({ id: x.id, postId: x.postId, body: x.body, createdAt: x.createdAt })),
      following: db.follows.filter((f) => f.followerId === u.id).map((f) => ({ username: nameOf(f.followeeId) })),
      followers: db.follows.filter((f) => f.followeeId === u.id).map((f) => ({ username: nameOf(f.followerId) })),
      conversations: [...convs.values()],
      groups: db.chatMembers.filter((m) => m.userId === u.id).map((m) => ({
        id: m.chatId,
        title: db.chats.find((c) => c.id === m.chatId)?.title ?? '',
        myMessages: db.chatMessages.filter((x) => x.chatId === m.chatId && x.authorId === u.id).map((x) => ({ id: x.id, body: x.body, createdAt: x.createdAt })),
      })),
    });
  },

  changeUsername: (raw: string) => {
    const u = requireMe()!;
    const username = raw.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) fail(400, 'Имя пользователя: 3–20 символов, только латиница, цифры и _');
    if (username === u.username) fail(400, 'Это и так ваш логин');
    if (usernameTaken(username, u.id)) fail(409, 'Это имя пользователя уже занято');
    const previous = u.username;
    const until = Date.now() + HOLD_DAYS * 864e5;
    db.usernameHolds = [
      ...db.usernameHolds.filter((h) => h.username !== username && h.username !== previous),
      { username: previous, userId: u.id, until },
    ];
    u.username = username;
    return tick({ user: publicUser(u), previous, heldUntil: new Date(until).toISOString(), holdDays: HOLD_DAYS });
  },

  setPrivacy: (patch: Partial<Privacy>) => {
    const u = requireMe()!;
    const given = PRIVACY_KEYS.filter((k) => patch[k] !== undefined);
    if (given.length === 0) fail(400, 'Нечего менять');
    if (given.some((k) => !OPTIONS.includes(patch[k]!))) fail(400, 'Настройка — all, follows, nobody');
    if (patch.lastSeen) u.lastSeenPrivacy = patch.lastSeen;
    if (patch.phoneFind) u.phoneFind = patch.phoneFind;
    if (patch.phoneShow) u.phoneShow = patch.phoneShow;
    return tick({ lastSeen: u.lastSeenPrivacy ?? 'all', phoneFind: u.phoneFind ?? 'nobody', phoneShow: u.phoneShow ?? 'nobody' });
  },

  changePassword: (currentPassword: string, newPassword: string) => {
    const u = requireMe()!;
    if (newPassword.length < 8) fail(400, 'Пароль должен быть не короче 8 символов');
    // Пароля ещё нет (аккаунт по номеру) — задаётся без текущего.
    if (u.password && u.password !== currentPassword) fail(403, 'Пароль не подходит');
    if (newPassword === currentPassword) fail(400, 'Новый пароль совпадает с текущим');
    u.password = newPassword;
    db.resets = db.resets.filter((r) => !(r.userId === u.id && !r.usedAt));
    return tick({ ok: true as const, ended: endOtherSessions(u.id) });
  },

  sessions: () => {
    const u = requireMe()!;
    const list = db.sessions
      .filter((s) => s.userId === u.id)
      .map((s) => ({ id: s.id, current: s.id === db.currentSession, createdAt: s.createdAt, userAgent: s.userAgent }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt));
    return tick({ sessions: list });
  },

  endSession: (sessionId: number) => {
    const u = requireMe()!;
    const s = db.sessions.find((x) => x.id === sessionId && x.userId === u.id);
    if (!s) fail(404, 'Сеанс не найден');
    if (s!.id === db.currentSession) fail(400, 'Это текущий сеанс — чтобы его закончить, нажмите «Выйти»');
    db.sessions = db.sessions.filter((x) => x !== s);
    return tick({ ok: true as const });
  },

  endOtherSessions: () => {
    const u = requireMe()!;
    return tick({ ok: true as const, ended: endOtherSessions(u.id) });
  },

  deleteAccount: (proof: { password: string } | { code: string }) => {
    const u = requireMe()!;
    if (u.password) {
      if (!('password' in proof) || u.password !== proof.password) fail(403, 'Пароль не подходит');
    } else {
      if (!u.phone) fail(400, 'Нет ни пароля, ни номера — удаление подтвердить нечем');
      checkCode(u.phone!, 'delete', 'code' in proof ? proof.code : '', u.id);
    }
    dropUser(u.id);
    db.meId = null;
    db.currentSession = null;
    return tick({ ok: true as const });
  },
};
