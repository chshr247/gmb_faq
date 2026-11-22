// Админ-панель сайта: вход через Telegram Login Widget и все её запросы.
// Фронт - admin.html + admin.js. Браузер с Supabase не разговаривает: service-ключ
// и токен бота живут только здесь.
//
// Действие в ?a=. Всё, кроме login, требует cookie админа.

import { checkWidget, readSession, signSession, cookieValue, setCookie } from './_auth.js';
import {
  sbJson, tg, send, esc, STATUS, isAdmin, getRow, isBlocked,
  applyStatus, applyBlock, supportHeader,
} from './_bot.js';

export const config = { runtime: 'edge' };

const token = () => process.env.TELEGRAM_BOT_TOKEN;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const text = (body, status) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// id из запроса идёт прямо в адрес PostgREST - пускаем только цифры.
const num = (value) => (/^\d{1,18}$/.test(String(value ?? '')) ? Number(value) : null);

// ── Вход ─────────────────────────────────────────────────────────────

const login = async (url) => {
  const params = Object.fromEntries(url.searchParams);
  delete params.a; // наш параметр в подпись Telegram не входит

  const user = await checkWidget(params, token());
  if (!user) return text('Подпись Telegram не сошлась или устарела. Попробуйте войти заново.', 403);
  if (!isAdmin(user.id)) return text('Этот Telegram-аккаунт не в списке админов.', 403);

  return new Response(null, {
    status: 302,
    headers: { location: '/admin.html', 'set-cookie': setCookie(await signSession(user.id, token())) },
  });
};

// ── Список ───────────────────────────────────────────────────────────

const LIST_COLUMNS = 'id,type,status,steam_id,telegram_id,telegram_name,discord,created_at,'
  + 'last_player_at,last_seen_at,source';

const SORTS = {
  new: 'id.desc',
  old: 'id.asc',
  wait: 'last_player_at.desc.nullslast', // кто написал и ждёт ответа
};

const PAGE = 30;

const list = async (url) => {
  const status = url.searchParams.get('status');
  const sort = SORTS[url.searchParams.get('sort')] ?? SORTS.new;
  const offset = num(url.searchParams.get('offset')) ?? 0;
  const q = (url.searchParams.get('q') ?? '').trim();

  let query = `/rest/v1/requests?select=${LIST_COLUMNS}&order=${sort}&limit=${PAGE + 1}&offset=${offset}`;
  if (STATUS[status]) query += `&status=eq.${status}`;
  if (q) {
    // Запятые, скобки и звёздочки ломают разбор or=(...) в PostgREST - убираем.
    const safe = encodeURIComponent(q.replace(/[(),*]/g, ' ').trim());
    const parts = [`steam_id.ilike.*${safe}*`, `telegram_name.ilike.*${safe}*`, `discord.ilike.*${safe}*`];
    if (/^\d+$/.test(q)) parts.push(`id.eq.${q}`, `telegram_id.eq.${q}`);
    query += `&or=(${parts.join(',')})`;
  }

  const rows = await sbJson(query);
  return { rows: rows.slice(0, PAGE), more: rows.length > PAGE, offset, page: PAGE };
};

// ── Одна заявка ──────────────────────────────────────────────────────

const one = async (id) => {
  const row = await getRow(id);
  if (!row) return { error: 'Заявка не найдена' };
  const messages = await sbJson(`/rest/v1/messages?request_id=eq.${id}&select=*&order=id.asc&limit=300`);
  const blocked = row.telegram_id ? await isBlocked(row.telegram_id) : false;
  // Открыл заявку - значит прочитал: точка непрочитанного гаснет.
  await sbJson(`/rest/v1/requests?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  });
  return { row, messages, blocked };
};

// ── Ответ игроку ─────────────────────────────────────────────────────

const reply = async (id, body, me) => {
  const message = String(body ?? '').trim().slice(0, 3800);
  if (!message) return { error: 'Пустое сообщение' };

  const row = await getRow(id);
  if (!row) return { error: 'Заявка не найдена' };
  if (!row.telegram_id) {
    return { error: `Заявка с сайта - игрока нет в боте. Discord: ${row.discord ?? '-'}` };
  }

  try {
    await send(row.telegram_id, { text: `${supportHeader(row.id)}\n${esc(message)}` });
  } catch (error) {
    console.error('admin reply', error);
    return {
      error: /blocked|deactivated|chat not found/.test(error.message)
        ? 'Не доставлено: игрок заблокировал бота или удалил аккаунт'
        : `Не доставлено: ${error.message}`,
    };
  }

  const [saved] = await sbJson('/rest/v1/messages', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ request_id: row.id, from_admin: true, admin_id: me, text: message, via: 'web' }),
  });
  return { message: saved };
};

// ── Шаблоны ответов ──────────────────────────────────────────────────

const templates = async (request, url) => {
  if (request.method === 'DELETE') {
    const id = num(url.searchParams.get('id'));
    if (!id) return { error: 'Нужен id' };
    await sbJson(`/rest/v1/reply_templates?id=eq.${id}`, { method: 'DELETE' });
    return { ok: true };
  }
  if (request.method === 'POST') {
    const { id, text: body, sort } = await request.json().catch(() => ({}));
    const value = String(body ?? '').trim().slice(0, 3800);
    if (!value) return { error: 'Пустой шаблон' };
    const row = { text: value, ...(sort === undefined ? {} : { sort: num(sort) ?? 0 }) };
    const [saved] = num(id)
      ? await sbJson(`/rest/v1/reply_templates?id=eq.${num(id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        })
      : await sbJson('/rest/v1/reply_templates', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        });
    return { template: saved };
  }
  return { rows: await sbJson('/rest/v1/reply_templates?select=*&order=sort.asc,id.asc') };
};

// ── Файл из Telegram ─────────────────────────────────────────────────

// Отдаём байты сами: токен бота в адресе файла, в браузер его пускать нельзя.
const file = async (fileId) => {
  if (!/^[\w-]{5,200}$/.test(String(fileId ?? ''))) return json({ error: 'Плохой id файла' }, 400);
  const { file_path: path } = await tg('getFile', { file_id: fileId });
  const upstream = await fetch(`https://api.telegram.org/file/bot${token()}/${path}`);
  if (!upstream.ok) return json({ error: 'Файл недоступен' }, 502);
  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'private, max-age=3600',
    },
  });
};

// ── Вход в функцию ───────────────────────────────────────────────────

export default async function handler(request) {
  const url = new URL(request.url);
  const action = url.searchParams.get('a') ?? '';

  if (action === 'login') return login(url);

  // Список админов проверяем на каждом запросе, а не только при входе: убрал
  // аккаунт из ADMIN_IDS - доступ пропал сразу, не дожидаясь конца cookie.
  const me = await readSession(cookieValue(request.headers.get('cookie')), token());
  if (!me || !isAdmin(me)) return json({ error: 'auth' }, 401);

  const body = request.method === 'POST' && action !== 'templates'
    ? await request.json().catch(() => ({}))
    : {};
  const id = num(body.id ?? url.searchParams.get('id'));

  try {
    switch (action) {
      case 'me':
        return json({ id: me });
      case 'list':
        return json(await list(url));
      case 'request':
        return id ? json(await one(id)) : json({ error: 'Нужен id' }, 400);
      case 'send':
        return id ? json(await reply(id, body.text, me)) : json({ error: 'Нужен id' }, 400);
      case 'status': {
        if (!id) return json({ error: 'Нужен id' }, 400);
        const r = await applyStatus(id, body.status);
        return json(r.error ? { error: r.error } : { row: r.row, text: r.text });
      }
      case 'block': {
        if (!id) return json({ error: 'Нужен id' }, 400);
        const r = await applyBlock(id);
        return json(r.error ? { error: r.error } : { blocked: r.blocked, text: r.text });
      }
      case 'note': {
        if (!id) return json({ error: 'Нужен id' }, 400);
        await sbJson(`/rest/v1/requests?id=eq.${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ admin_note: String(body.note ?? '').slice(0, 2000) || null }),
        });
        return json({ ok: true });
      }
      case 'templates':
        return json(await templates(request, url));
      case 'file':
        return file(url.searchParams.get('id'));
      default:
        return json({ error: 'Неизвестное действие' }, 404);
    }
  } catch (error) {
    console.error('admin', action, error);
    return json({ error: 'Ошибка сервера, смотри логи Vercel' }, 500);
  }
}
