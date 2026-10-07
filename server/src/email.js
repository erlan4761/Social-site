const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM ?? 'Duet <onboarding@resend.dev>';

/**
 * Отправляет письмо через Resend (обычный HTTP-запрос, без SDK — незачем
 * тащить зависимость ради одного вызова). Без RESEND_API_KEY письмо просто
 * печатается в консоль сервера: это не заглушка на скорую руку, а рабочий
 * режим для локальной разработки и тестов — почтовый аккаунт для них не
 * нужен, ссылку на сброс пароля видно прямо в логе.
 */
export async function sendMail({ to, subject, text }) {
  if (!RESEND_API_KEY) {
    console.log(`\n✉️  Почта не настроена (нет RESEND_API_KEY) — печатаю письмо в консоль\nКому: ${to}\nТема: ${subject}\n\n${text}\n`);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, text }),
    });
    if (!res.ok) {
      console.error('Resend: письмо не отправлено', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    // Отправка не должна ронять запрос — сброс пароля отвечает одинаково
    // независимо от того, дошло письмо или нет (см. forgot-password).
    console.error('Resend: ошибка сети', err);
  }
}

// На Render это подставлять руками не нужно: платформа сама даёт
// RENDER_EXTERNAL_URL с публичным адресом сервиса. Явный PUBLIC_URL всё
// равно имеет приоритет — на случай отдельного домена или другого хостинга.
export const PUBLIC_URL = process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:5173';
