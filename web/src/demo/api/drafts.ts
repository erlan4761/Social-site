import { type PrefKind } from '../../api';
import { db, fail, tick } from '../store';
import { byName, requireMe } from '../model/people';
import { draftOf, saveDraft } from '../model/drafts';

/** Методы витрины: черновики. Цель — та же, что в адресе чата; чужое — 404. */

const MAX: Record<PrefKind, number> = { dm: 1000, chat: 1000, channel: 4000 };

function targetOf(kind: PrefKind, raw: string | number, me: number) {
  if (kind === 'dm') return byName(String(raw))?.id ?? null;
  if (kind === 'chat') {
    const id = Number(raw);
    return db.chatMembers.some((m) => m.chatId === id && m.userId === me) ? id : null;
  }
  const handle = String(raw).toLowerCase().replace(/^@/, '');
  return db.channels.find((c) => c.handle === handle && c.ownerId === me)?.id ?? null;
}

function resolve(kind: PrefKind, raw: string | number) {
  const u = requireMe()!;
  const targetId = targetOf(kind, raw, u.id);
  if (targetId == null) fail(404, 'Чат не найден');
  return { me: u.id, targetId: targetId! };
}

export const draftsApi = {
  draft: (kind: PrefKind, target: string | number) => {
    const { me, targetId } = resolve(kind, target);
    return tick({ draft: draftOf(me, kind, targetId) });
  },

  saveDraft: (kind: PrefKind, target: string | number, text: string) => {
    const { me, targetId } = resolve(kind, target);
    if (text.length > MAX[kind]) fail(400, `«черновик»: максимум ${MAX[kind]} символов`);
    return tick({ draft: saveDraft(me, kind, targetId, text) });
  },
};
