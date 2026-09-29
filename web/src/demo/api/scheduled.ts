import { type ScheduledKind } from '../../api';
import { type DbScheduled, db, id, tick, fail } from '../store';
import { requireMe } from '../model/people';
import { BODY_MAX } from '../model/messages';
import { toScheduled, scheduleTarget, deliverScheduled, readSendAt, requireScheduled } from '../model/scheduled';

/** Методы витрины: отложенные сообщения. */

export const scheduledApi = {
  // ─ Отложенные ──────────────────────────────────────────────────────────

  scheduled: (kind: ScheduledKind, target: string | number) => {
    const u = requireMe()!;
    const targetId = scheduleTarget(kind, target, u);
    const list = db.scheduledMessages
      .filter((s) => s.userId === u.id && s.kind === kind && s.targetId === targetId)
      .sort((a, b) => a.sendAt.localeCompare(b.sendAt) || a.id - b.id)
      .map(toScheduled);
    return tick({ scheduled: list });
  },

  schedule: (kind: ScheduledKind, target: string | number, text: string, sendAt: string) => {
    const u = requireMe()!;
    const targetId = scheduleTarget(kind, target, u);
    if (targetId == null) fail(404, 'Переписка не найдена');
    const body = text.trim();
    const max = kind === 'channel' ? 4000 : BODY_MAX;
    if (!body) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > max) fail(400, `«сообщение»: максимум ${max} символов`);
    if (db.scheduledMessages.filter((s) => s.userId === u.id).length >= 100) fail(400, 'Отложенных сообщений — не больше 100');
    const s: DbScheduled = {
      id: id(), userId: u.id, kind, targetId: targetId!, body, sendAt: readSendAt(sendAt), createdAt: new Date().toISOString(),
    };
    db.scheduledMessages.push(s);
    return tick({ scheduled: toScheduled(s) });
  },

  updateScheduled: (scheduledId: number, input: { body?: string; sendAt?: string }) => {
    const s = requireScheduled(scheduledId);
    if (input.body !== undefined) {
      const body = input.body.trim();
      if (!body) fail(400, '«сообщение»: минимум 1 символов');
      s.body = body;
    }
    if (input.sendAt !== undefined) s.sendAt = readSendAt(input.sendAt);
    return tick({ scheduled: toScheduled(s) });
  },

  deleteScheduled: (scheduledId: number) => {
    const s = requireScheduled(scheduledId);
    db.scheduledMessages = db.scheduledMessages.filter((x) => x !== s);
    return tick({ ok: true as const });
  },

  sendScheduledNow: (scheduledId: number) => {
    const s = requireScheduled(scheduledId);
    const messageId = deliverScheduled(s);
    if (messageId == null) fail(403, 'Отправить уже нельзя — переписка недоступна');
    return tick({ ok: true as const, messageId: messageId! });
  },
};
