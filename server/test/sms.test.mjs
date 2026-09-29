// Адаптер SMS.ru против поддельного SMS.ru: `npm run test:sms` из server/.
// Twilio проверяет смоук-тест (секция «вход и регистрация по номеру»).
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const received = [];
let reply = { status: 'OK', sms: {} };
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ path: req.url, form: new URLSearchParams(Buffer.concat(chunks).toString()) });
    // SMS.ru отвечает 200 и на ошибки — разбирать надо тело.
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  });
});

let sendSms;
let SmsError;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, {
    SMS_PROVIDER: 'smsru',
    SMSRU_API_ID: 'test-api-id',
    SMSRU_FROM: 'Hronika',
    SMSRU_API_BASE: `http://127.0.0.1:${server.address().port}`,
  });
  // Провайдер выбирается при загрузке модуля — поэтому импорт после настройки.
  ({ sendSms, SmsError } = await import('../src/sms.js'));
});
after(() => server.close());

test('отправляет форму, которую ждёт SMS.ru', async () => {
  reply = { status: 'OK', sms: { 996555123456: { status: 'OK', status_code: 100, sms_id: '1' } } };
  await sendSms('+996555123456', 'Хроника: код 123456.');
  const { path, form } = received.at(-1);
  assert.equal(path, '/sms/send');
  assert.equal(form.get('api_id'), 'test-api-id');
  assert.equal(form.get('to'), '996555123456', 'номер — без плюса');
  assert.equal(form.get('msg'), 'Хроника: код 123456.');
  assert.equal(form.get('json'), '1');
  assert.equal(form.get('from'), 'Hronika');
});

test('общая ошибка SMS.ru — SmsError, хоть HTTP и 200', async () => {
  reply = { status: 'ERROR', status_code: 200, status_text: 'Неправильный api_id' };
  await assert.rejects(sendSms('+996555123456', 'x'), (err) => err instanceof SmsError && /api_id/.test(err.message));
});

test('ошибка по номеру при общем OK — тоже отказ', async () => {
  reply = { status: 'OK', sms: { 996555123456: { status: 'ERROR', status_code: 207, status_text: 'На этот номер нельзя отправлять' } } };
  await assert.rejects(sendSms('+996555123456', 'x'), (err) => err instanceof SmsError && /нельзя/.test(err.message));
});
