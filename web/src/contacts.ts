import { toE164 } from './phone';

/**
 * Выбор из контактов телефона — Contact Picker API. Есть в Chrome на Android;
 * в остальных браузерах кнопки просто нет. Сайт не видит адресную книгу
 * целиком: человек сам отмечает, кого показать, и уходят только их номера.
 */
type ContactsManager = {
  select(props: 'tel'[], options?: { multiple?: boolean }): Promise<{ tel?: string[] }[]>;
};

/** Столько номеров сервер принимает за раз. */
export const CONTACTS_MAX = 50;

export const canPickContacts = () =>
  typeof window !== 'undefined' && 'ContactsManager' in window && 'contacts' in navigator;

/** Номера выбранных контактов в E.164. Местные («0555…», «8 916…») — с кодом страны `dial`. */
export async function pickContactPhones(dial: string) {
  const { contacts } = navigator as Navigator & { contacts: ContactsManager };
  const picked = await contacts.select(['tel'], { multiple: true });
  return toPhones(picked.flatMap((c) => c.tel ?? []), dial);
}

export function toPhones(raw: string[], dial: string) {
  const phones = new Set<string>();
  for (const tel of raw) {
    if (tel.replace(/\D/g, '').length >= 6) phones.add(toE164(dial, tel));
  }
  return [...phones].slice(0, CONTACTS_MAX);
}
