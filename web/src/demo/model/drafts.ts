import { type Draft, type PrefKind } from '../../api';
import { db } from '../store';

/** Черновики — как drafts.js: по одному на человека и чат, пустой — значит, нет. */

export const draftOf = (userId: number, kind: PrefKind, targetId: number): Draft | null => {
  const d = db.drafts.find((x) => x.userId === userId && x.kind === kind && x.targetId === targetId);
  return d ? { body: d.body, updatedAt: d.updatedAt } : null;
};

export function clearDraft(userId: number, kind: PrefKind, targetId: number) {
  db.drafts = db.drafts.filter((x) => !(x.userId === userId && x.kind === kind && x.targetId === targetId));
}

export function saveDraft(userId: number, kind: PrefKind, targetId: number, body: string) {
  clearDraft(userId, kind, targetId);
  if (!body.trim()) return null;
  db.drafts.push({ userId, kind, targetId, body, updatedAt: new Date().toISOString() });
  return draftOf(userId, kind, targetId);
}
