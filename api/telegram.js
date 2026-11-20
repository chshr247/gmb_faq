import { handle } from './_bot.js';

// Вебхук бота. Блокировка Vercel в России ему не мешает: этот адрес вызывают
// серверы Telegram, а не телефон игрока.
export const config = { runtime: 'edge' };

const ok = () => new Response('ok');

export default async function handler(request) {
  if (request.method !== 'POST') return ok();

  // Без секрета любой, кто знает адрес, прислал бы поддельный апдейт - например,
  // «нажатие» админской кнопки от имени админа. Секрет задаётся в setWebhook.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    console.error('telegram: апдейт без верного секрета');
    return ok();
  }

  // Всегда 200: на ошибку Telegram повторял бы тот же апдейт снова и снова.
  // Обрабатываем до ответа, а не в фоне: с max_connections=1 в setWebhook
  // апдейты одного чата идут строго по очереди и не гонятся за tg_state.
  try {
    await handle(await request.json());
  } catch (error) {
    console.error('telegram', error);
  }
  return ok();
}
