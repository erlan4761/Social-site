import { db } from './db.js';
import { isBlockedPair } from './blocks.js';
import { normalizePhone } from './phone.js';

/**
 * Номер телефона глазами других. Как в Телеграме — две настройки, — но
 * осторожнее по умолчанию:
 *
 *   phone_find — кто найдёт человека, зная его номер целиком;
 *   phone_show — кому номер виден в профиле.
 *
 * Значения те же, что у времени захода: all / follows / nobody. «follows» —
 * те, на кого подписан сам владелец номера: у нас это ближайший аналог «моих
 * контактов». Обе настройки по умолчанию «nobody»: номер — не публичные данные,
 * и находиться по нему человек соглашается сам — галочкой при регистрации или
 * в настройках. Иначе любой, кто перебирает номера подряд, собирал бы карту
 * «номер → аккаунт» без спроса.
 */
export const PHONE_PRIVACY_OPTIONS = ['all', 'follows', 'nobody'];

/** Сколько номеров за один запрос: хватает на выбор из контактов, мало для перебора. */
export const LOOKUP_MAX = 50;

const follows = (from, to) =>
  Boolean(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(from, to));

/** Разрешает ли настройка владельца `ownerId` что-то человеку `viewerId`. */
function allows(privacy, ownerId, viewerId) {
  if (privacy === 'all') return true;
  if (privacy === 'follows') return follows(ownerId, viewerId);
  return false;
}

/**
 * Номер в профиле. Гостю — никогда: страницу профиля видят и без входа, а
 * номер, открытый поисковикам, — это спам и звонки. Себе — если его вообще
 * кому-то видно: профиль показывает то, что видят другие.
 */
export function visiblePhone(owner, viewerId) {
  if (!owner.phone || viewerId == null) return null;
  if (owner.id === viewerId) return owner.phone_show === 'nobody' ? null : owner.phone;
  if (isBlockedPair(owner.id, viewerId)) return null;
  return allows(owner.phone_show, owner.id, viewerId) ? owner.phone : null;
}

/**
 * Кого из этих номеров смотрящему можно найти. Неразборчивые номера молча
 * пропускаются — в контактах бывает всякое. Ответ не различает «номера нет»
 * и «человек не разрешил»: иначе поиск выдавал бы, кто здесь зарегистрирован.
 */
export function findByPhones(viewerId, raw) {
  const phones = new Set();
  for (const item of raw) {
    try {
      phones.add(normalizePhone(item));
    } catch {
      // не номер — пропускаем
    }
  }
  if (phones.size === 0) return [];
  const list = [...phones];
  const rows = db.prepare(`
    SELECT id, username, display_name, avatar_path, phone, phone_find
    FROM users
    WHERE phone IN (${list.map(() => '?').join(', ')}) AND id <> ?
    ORDER BY display_name
  `).all(...list, viewerId);
  return rows.filter((u) => !isBlockedPair(u.id, viewerId) && allows(u.phone_find, u.id, viewerId));
}
