import { type LastSeenPrivacy } from '../../api';
import { type DbUser, db, id, tick, fail } from '../store';
import { openSession, endOtherSessions, dropUser } from '../model/account';
import { byId, byName, byEmail, me, requireMe } from '../model/people';
import { publicUser } from '../model/posts';
import { notifyLogin } from '../model/notifications';
import { checkCode, dropTicket, issueTicket, normalizePhone, readTicket, sendCode } from '../model/phone';
import type { PhoneVerdict } from '../../api';

/** Методы витрины: вход, регистрация, пароль, настройки аккаунта. */

export const authApi = {
  // Пуш-уведомлений у витрины нет: их доставляет сервер, а его здесь нет.
  pushKey: () => fail(400, 'В витрине пуш-уведомлений нет — они приходят от сервера'),
  savePushSubscription: (_subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    fail(400, 'В витрине пуш-уведомлений нет — они приходят от сервера'),
  deletePushSubscription: (_endpoint: string) => tick({ ok: true as const }),

  me: () => tick({ user: me() ? publicUser(me()!) : null }),

  // ─ Вход по номеру ─────────────────────────────────────────────────

  phoneStart: (raw: string) => tick(sendCode(normalizePhone(raw), 'login')),

  phoneVerify: (raw: string, code: string) => {
    const phone = normalizePhone(raw);
    checkCode(phone, 'login', code);
    const u = db.users.find((x) => x.phone === phone);
    let verdict: PhoneVerdict;
    if (!u) verdict = { status: 'signup', ticket: issueTicket('signup', phone) };
    else if (u.password) verdict = { status: 'password', ticket: issueTicket('password', phone, u.id) };
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
    db.meId = u!.id;
    openSession(u!.id);
    notifyLogin(u!.id);
    return tick({ user: publicUser(u!) });
  },

  phoneSignup: (token: string, rawName: string, displayName: string) => {
    const ticket = readTicket(token, 'signup');
    const username = rawName.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) fail(400, 'Имя пользователя: 3–20 символов, только латиница, цифры и _');
    if (byName(username)) fail(409, 'Это имя пользователя уже занято');
    if (db.users.some((x) => x.phone === ticket.phone)) {
      dropTicket(ticket.token);
      fail(409, 'Этот номер уже зарегистрирован — войдите по нему заново');
    }
    const u: DbUser = {
      id: id(), username, displayName: displayName.trim() || username,
      bio: '', avatarUrl: null, createdAt: new Date().toISOString(), email: null, password: '',
      phone: ticket.phone, passwordLogin: false, lastSeenAt: new Date().toISOString(),
    };
    db.users.push(u);
    dropTicket(ticket.token);
    db.meId = u.id;
    openSession(u.id);
    return tick({ user: publicUser(u) });
  },

  login: (input: { username: string; password: string }) => {
    const u = byName(input.username.trim());
    // Аккаунт по номеру по логину не входит: его пароль — второй шаг после кода.
    if (!u || u.passwordLogin === false || !u.password || u.password !== input.password) {
      fail(401, 'Неверное имя пользователя или пароль');
    }
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
      createdAt: u.createdAt,
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

  setLastSeen: (lastSeen: LastSeenPrivacy) => {
    const u = requireMe()!;
    if (!['all', 'follows', 'nobody'].includes(lastSeen)) fail(400, '«Кто видит время захода» — all, follows, nobody');
    u.lastSeenPrivacy = lastSeen;
    return tick({ lastSeen });
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
