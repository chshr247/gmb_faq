import * as v from '../validators.js';

// Edge-runtime: у запроса есть готовый formData(), поэтому парсер multipart не нужен.
export const config = { runtime: 'edge' };

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  IP_SALT,
} = process.env;

const PER_HOUR = 3;
const PER_DAY = 10;
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 365;

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const sha256 = async (text) => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const sb = (path, init = {}) =>
  fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...init.headers,
    },
  });

const countSince = async (ipHash, since) => {
  const response = await sb(
    `/rest/v1/requests?ip_hash=eq.${ipHash}&created_at=gte.${since}&select=id`,
    { method: 'HEAD', headers: { Prefer: 'count=exact', Range: '0-0' } },
  );
  return Number(response.headers.get('content-range')?.split('/')[1] ?? 0);
};

const upload = async (file, type) => {
  const path = `${type}/${Date.now()}-${crypto.randomUUID()}.${EXT[file.type]}`;

  const put = await sb(`/storage/v1/object/screenshots/${path}`, {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!put.ok) throw new Error(`storage: ${await put.text()}`);

  const signed = await sb(`/storage/v1/object/sign/screenshots/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expiresIn: SIGNED_URL_SECONDS }),
  });
  if (!signed.ok) throw new Error(`sign: ${await signed.text()}`);

  const { signedURL } = await signed.json();
  return `${SUPABASE_URL}/storage/v1${signedURL}`;
};

const insert = async (row) => {
  const response = await sb('/rest/v1/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!response.ok) throw new Error(`insert: ${await response.text()}`);
  return (await response.json())[0];
};

const esc = (value) =>
  String(value ?? '-').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const caption = (row) => {
  const lines =
    row.type === 'privilege'
      ? [
          `🟣 <b>ВЕРНУТЬ ПРИВИЛЕГИЮ · #${row.id}</b>`,
          `Причина: ${esc(row.reason)}`,
        ]
      : [
          `🟡 <b>НЕ ПРИШЁЛ ДОНАТ · #${row.id}</b>`,
          `Сумма: <b>${esc(row.amount)}</b> кредитов`,
          `Оплата: ${esc(row.payment_method)}`,
          `Дата: ${new Date(row.paid_at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК)`,
        ];

  lines.push(
    `SteamID: <code>${esc(row.steam_id)}</code>` +
      (v.STEAM_ID_CANON.test(row.steam_id) ? '' : ' ⚠ не STEAM_0, проверьте'),
    `Discord: <code>${esc(row.discord)}</code>`,
  );
  if (row.comment) lines.push(`Коммент: ${esc(row.comment)}`);
  if (row.screenshot_url) lines.push(`<a href="${row.screenshot_url}">Скриншот</a>`);
  return lines.join('\n');
};

// sendDocument, а не sendPhoto: Telegram сжимает фото, и мелкий текст лога покупок
// становится нечитаемым.
const notify = async (row, file) => {
  const api = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
  const text = caption(row);

  if (file) {
    const form = new FormData();
    form.set('chat_id', TELEGRAM_CHAT_ID);
    form.set('caption', text);
    form.set('parse_mode', 'HTML');
    form.set('document', file, `${row.type}-${row.id}.${EXT[file.type]}`);
    return fetch(`${api}/sendDocument`, { method: 'POST', body: form });
  }

  return fetch(`${api}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
};

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);

  const form = await request.formData();
  const data = Object.fromEntries(form);
  const type = data.type;

  // Ботам отвечаем «ок» и ничего не сохраняем - пусть считают, что сработало.
  if (data.website) return json({ ok: true });
  if (Number(data.elapsed) < v.MIN_FILL_SECONDS) return json({ ok: true });

  const errors = v.validate(type, data);

  const file = form.get('screenshot');
  const hasFile = file instanceof File && file.size > 0;
  if (hasFile && !v.imageFile(file)) errors.screenshot = 'Только JPG, PNG или WEBP до 5 МБ';
  if (!hasFile) {
    errors.screenshot =
      type === 'privilege' ? 'Прикрепите скриншот лога покупок' : 'Прикрепите скриншот чека';
  }
  // ponytail: ширину скриншота проверяет только браузер - декодировать картинку
  // на сервере ради этого не стоит. Обрезанный скрин всё равно виден глазами.

  if (Object.keys(errors).length) return json({ errors }, 400);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Не заданы переменные окружения - см. .env.example');
    return json({ error: 'Приём заявок временно не работает. Напишите в Discord: cheshirecat247' }, 503);
  }

  try {
    const ipHash = await sha256(
      (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() + IP_SALT,
    );
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    const dayAgo = new Date(Date.now() - 86400e3).toISOString();

    if ((await countSince(ipHash, hourAgo)) >= PER_HOUR || (await countSince(ipHash, dayAgo)) >= PER_DAY) {
      return json({ error: 'Слишком много заявок. Попробуйте позже или напишите в Discord: cheshirecat247' }, 429);
    }

    const row = await insert({
      type,
      steam_id: String(data.steam_id).trim().toUpperCase(),
      discord: String(data.discord).trim().replace(/^@/, ''),
      reason: type === 'privilege' ? data.reason : null,
      amount: type === 'donate' ? Number(data.amount) : null,
      payment_method: type === 'donate' ? data.payment_method : null,
      // Дата приходит без времени и означает московский день - закрепляем это
      // смещением, иначе UTC сдвинет её на сутки назад.
      paid_at: type === 'donate' ? new Date(`${data.paid_at}T00:00:00+03:00`).toISOString() : null,
      comment: data.comment?.trim() || null,
      screenshot_url: hasFile ? await upload(file, type) : null,
      ip_hash: ipHash,
    });

    // Заявка уже сохранена, поэтому отказ Telegram не роняет ответ игроку.
    // Но в лог он попасть обязан, иначе пропажу уведомлений нечем объяснить.
    await notify(row, hasFile ? file : null)
      .then(async (response) => {
        if (!response.ok) console.error(`telegram ${response.status}: ${await response.text()}`);
      })
      .catch((error) => console.error('telegram', error));

    return json({ ok: true, id: row.id });
  } catch (error) {
    console.error(error);
    return json({ error: 'Не удалось сохранить заявку' }, 500);
  }
}
