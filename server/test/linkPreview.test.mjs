// Юнит-тесты безопасного скачивания для предпросмотра ссылок: какие адреса
// закрыты, какие ссылки принимаются, как разбирается страница. Без сервера и
// без базы: npm run test:preview.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// Правила — как в продакшене: смоук-тест в CI разрешает петлю переменной на
// весь job, а здесь проверяется именно запрет. Поэтому переменную убираем до
// загрузки модуля (он читает её один раз).
delete process.env.LINK_PREVIEW_ALLOW_LOOPBACK;
const { decodeHtml, fetchSafe, isPublicAddress, parsePage, readUrl } = await import('../src/safeFetch.js');

test('частные, локальные и служебные адреса закрыты', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.10', '203.0.113.5',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2002:c0a8:101::1', '2001::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '::ffff:a00:1', '64:ff9b::a00:1',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('публичные адреса открыты', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4010::1', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('не IP — закрыт', () => {
  assert.equal(isPublicAddress('localhost'), false);
  assert.equal(isPublicAddress(''), false);
});

test('ссылка: только http(s), без логина, порт 80/443, без якоря', () => {
  assert.equal(readUrl('ftp://example.com/'), null);
  assert.equal(readUrl('javascript:alert(1)'), null);
  assert.equal(readUrl('http://user:pass@example.com/'), null);
  assert.equal(readUrl('http://example.com:6379/'), null);
  assert.equal(readUrl('не ссылка'), null);
  assert.equal(readUrl(`https://example.com/${'a'.repeat(2100)}`), null);
  assert.equal(readUrl(42), null);
  assert.equal(readUrl('https://example.com:443/путь?q=1#якорь').href, 'https://example.com/%D0%BF%D1%83%D1%82%D1%8C?q=1');
});

test('закрытый адрес отвергается ещё до соединения', async () => {
  await assert.rejects(fetchSafe(new URL('http://169.254.169.254/latest/meta-data'), { accept: '*/*', max: 1024 }), { code: 'EBLOCKED' });
  await assert.rejects(fetchSafe(new URL('http://[::ffff:10.0.0.1]/'), { accept: '*/*', max: 1024 }), { code: 'EBLOCKED' });
  // Десятичная запись — тот же 127.0.0.1 после разбора URL.
  await assert.rejects(fetchSafe(new URL('http://2130706433/'), { accept: '*/*', max: 1024 }), { code: 'EBLOCKED' });
});

test('имя, которое указывает внутрь, отвергается при DNS-поиске', async () => {
  // localhost — это 127.0.0.1 и ::1: имя проходит, адреса — нет.
  await assert.rejects(fetchSafe(new URL('http://localhost/'), { accept: '*/*', max: 1024 }), { code: 'EBLOCKED' });
});

test('Open Graph: заголовок, описание, сайт, картинка — с сущностями и относительной ссылкой', () => {
  const html = `<html><head>
    <meta content="Плёнка &amp; свет" property="og:title">
    <meta property='og:description' content='Как проявить &laquo;Ильфорд&raquo; дома'>
    <meta property="og:site_name" content="Заметки">
    <meta property="og:image" content="/img/cover.jpg?a=1&amp;b=2">
    <title>Запасной заголовок</title></head></html>`;
  assert.deepEqual(parsePage(html, new URL('https://notes.example/post/1')), {
    title: 'Плёнка & свет',
    description: 'Как проявить «Ильфорд» дома',
    siteName: 'Заметки',
    image: 'https://notes.example/img/cover.jpg?a=1&b=2',
  });
});

test('без Open Graph — <title>, meta description и имя хоста', () => {
  const html = '<title>\n  Просто   страница </title><meta name="description" content="Описание">';
  assert.deepEqual(parsePage(html, new URL('https://www.example.com/')), {
    title: 'Просто страница', description: 'Описание', siteName: 'example.com', image: null,
  });
});

test('без заголовка превью нет; картинка не http(s) — отбрасывается', () => {
  assert.equal(parsePage('<p>нет заголовка</p>', new URL('https://example.com/')), null);
  const html = '<meta property="og:title" content="X"><meta property="og:image" content="javascript:alert(1)">';
  assert.equal(parsePage(html, new URL('https://example.com/')).image, null);
});

test('кодировка из <meta charset>, неизвестная — как UTF-8', () => {
  const cp1251 = Buffer.concat([Buffer.from('<meta charset="windows-1251"><title>'), Buffer.from([0xcf, 0xf0, 0xee, 0xff, 0xe2, 0xea, 0xe0]), Buffer.from('</title>')]);
  assert.match(decodeHtml(cp1251, 'text/html'), /<title>Проявка<\/title>/);
  assert.match(decodeHtml(Buffer.from('<title>Да</title>'), 'text/html; charset=x-unknown'), /Да/);
});
