import { type PhonePrivacy } from '../../api';
import { type DbUser, db } from '../store';
import { blockedPair } from './people';
import { normalizePhone } from './phone';

/** Номер глазами других — как phoneBook.js: кто найдёт по номеру и кому он виден. */

const allows = (privacy: PhonePrivacy | undefined, ownerId: number, viewerId: number) => {
  if (privacy === 'all') return true;
  if (privacy === 'follows') return db.follows.some((f) => f.followerId === ownerId && f.followeeId === viewerId);
  return false;
};

/** Гостю — никогда; себе — если номер вообще кому-то виден. */
export function visiblePhone(owner: DbUser, viewerId: number | null) {
  if (!owner.phone || viewerId == null) return null;
  if (owner.id === viewerId) return (owner.phoneShow ?? 'nobody') === 'nobody' ? null : owner.phone;
  if (blockedPair(owner.id, viewerId)) return null;
  return allows(owner.phoneShow, owner.id, viewerId) ? owner.phone : null;
}

/** Кого из номеров смотрящему можно найти; неразборчивые пропускаются. */
export function findByPhones(viewerId: number, raw: string[]) {
  const phones = new Set<string>();
  for (const item of raw) {
    try {
      phones.add(normalizePhone(item));
    } catch {
      // не номер — пропускаем
    }
  }
  return db.users
    .filter((u) => u.phone && phones.has(u.phone) && u.id !== viewerId)
    .filter((u) => !blockedPair(u.id, viewerId) && allows(u.phoneFind, u.id, viewerId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
