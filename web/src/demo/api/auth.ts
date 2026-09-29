import { type LastSeenPrivacy } from '../../api';
import { type DbUser, db, id, tick, fail } from '../store';
import { openSession, endOtherSessions, dropUser } from '../model/account';
import { byId, byName, byEmail, me, requireMe } from '../model/people';
import { publicUser } from '../model/posts';

/** Методы витрины: вход, регистрация, пароль, настройки аккаунта. */

export const authApi = {
  // Пуш-уведомлений у витрины нет: их доставляет сервер, а его здесь нет.
  pushKey: () => fail(400, 'В витрине пуш-уведомлений нет — они приходят от сервера'),
  savePushSubscription: (_subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    fail(400, 'В витрине пуш-уведомлений нет — они приходят от сервера'),
  deletePushSubscription: (_endpoint: string) => tick({ ok: true as const }),

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
    if (db.users.some((u) => u.email === email)) fail(409, 'На этот email уже зарегистрирован аккаунт');

    const u: DbUser = {
      id: id(), username,
      displayName: input.displayName.trim() || username,
      bio: '', avatarUrl: null, createdAt: new Date().toISOString(), email, password: input.password,
      lastSeenAt: new Date().toISOString(),
    };
    db.users.push(u);
    db.meId = u.id;
    openSession(u.id);
    return tick({ user: publicUser(u) });
  },

  login: (input: { username: string; password: string }) => {
    const u = byName(input.username.trim());
    if (!u || u.password !== input.password) fail(401, 'Неверное имя пользователя или пароль');
    db.meId = u!.id;
    openSession(u!.id);
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

  deleteAccount: (password: string) => {
    const u = requireMe()!;
    if (u.password !== password) fail(403, 'Пароль не подходит');
    dropUser(u.id);
    db.meId = null;
    db.currentSession = null;
    return tick({ ok: true as const });
  },
};
