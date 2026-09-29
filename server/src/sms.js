/**
 * Отправка SMS. Провайдер выбирается переменной SMS_PROVIDER:
 *
 *   twilio  — TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN и либо TWILIO_FROM (номер
 *             отправителя), либо TWILIO_MESSAGING_SERVICE_SID;
 *   smsru   — SMSRU_API_ID и, по желанию, SMSRU_FROM (имя отправителя,
 *             согласованное в кабинете SMS.ru);
 *   console — код печатается в лог сервера. Только для разработки: в
 *             продакшене так войти мог бы кто угодно под чужим номером,
 *             поэтому там console не работает никогда.
 *
 * Без провайдера в продакшене вход по номеру честно отвечает «не настроен», а
 * не пускает всех подряд. Адреса API можно подменить (TWILIO_API_BASE,
 * SMSRU_API_BASE) — так тесты подставляют свой сервер вместо настоящего.
 */

const production = process.env.NODE_ENV === 'production';

function pick() {
  const wanted = (process.env.SMS_PROVIDER ?? (production ? '' : 'console')).toLowerCase();
  if (wanted === 'twilio') {
    const ok = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
      && (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID);
    return ok ? 'twilio' : null;
  }
  if (wanted === 'smsru') return process.env.SMSRU_API_ID ? 'smsru' : null;
  if (wanted === 'console') return production ? null : 'console';
  return null;
}

const provider = pick();
export const smsConfigured = provider != null;

if (provider === 'console') {
  console.warn('📱 SMS печатаются в лог (SMS_PROVIDER=console) — для разработки, не для продакшена.');
} else if (provider) {
  console.log(`📱 SMS отправляет ${provider}.`);
} else {
  console.warn('📱 SMS-провайдер не настроен: вход и регистрация по номеру недоступны (см. SMS_PROVIDER в README).');
}

export class SmsError extends Error {}

async function viaTwilio(to, text) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const base = process.env.TWILIO_API_BASE ?? 'https://api.twilio.com';
  const form = new URLSearchParams({ To: to, Body: text });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From', process.env.TWILIO_FROM);
  const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new SmsError(`Twilio ${res.status}: ${body.message ?? 'без описания'}`);
  }
}

async function viaSmsRu(to, text) {
  const base = process.env.SMSRU_API_BASE ?? 'https://sms.ru';
  const number = to.replace(/^\+/, '');
  const form = new URLSearchParams({ api_id: process.env.SMSRU_API_ID, to: number, msg: text, json: '1' });
  if (process.env.SMSRU_FROM) form.set('from', process.env.SMSRU_FROM);
  const res = await fetch(`${base}/sms/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const body = await res.json().catch(() => null);
  // SMS.ru отвечает 200 и на ошибки: смотреть надо на статус — и общий, и по номеру.
  const perNumber = body?.sms?.[number];
  if (!res.ok || body?.status !== 'OK' || perNumber?.status !== 'OK') {
    throw new SmsError(`SMS.ru: ${perNumber?.status_text ?? body?.status_text ?? res.status}`);
  }
}

/** Отправить SMS на номер в формате E.164. Бросает SmsError, если не вышло. */
export async function sendSms(to, text) {
  if (provider === 'twilio') return viaTwilio(to, text);
  if (provider === 'smsru') return viaSmsRu(to, text);
  if (provider === 'console') {
    console.log(`📱 SMS для ${to}: ${text.split('\n')[0]}`);
    return;
  }
  throw new SmsError('SMS-провайдер не настроен');
}
