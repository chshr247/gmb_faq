// Бот заявок: анкета игрока, карточки и кнопки админа, переписка, панель.
// Вебхук - api/telegram.js. Файл с подчёркиванием Vercel маршрутом не считает.
//
// Устроено в два слоя:
//   step()   - анкета без сети: состояние + ввод -> новое состояние + ответы.
//              Её и проверяет bot.test.mjs.
//   handle() - всё, что ходит в Telegram и Supabase.

import * as v from '../validators.js';

// Переменные читаем при вызове, а не при загрузке модуля - так их видно тестам.
const env = () => process.env;

const PER_HOUR = 3;
const PER_DAY = 10;
const STATE_TTL = 24 * 3600e3; // брошенная анкета через сутки начинается заново
// Режим ответа короткий: нажал «Ответить» и забыл - через час случайный текст
// игроку уже не уйдёт.
const REPLY_TTL = 15 * 60e3;
const PAGE = 5;

// Постоянные кнопки внизу чата. Они приходят обычным текстом, поэтому
// разбираются раньше анкеты - иначе «Мои заявки» стало бы ответом на вопрос.
const NEW_BUTTON = '📝 Подать заявку';
const MY_BUTTON = '📄 Мои заявки';
const PANEL_BUTTON = '📋 Все заявки';
const BUTTONS = [NEW_BUTTON, MY_BUTTON, PANEL_BUTTON];

const DISCORD = 'cheshirecat247';
const BLOCKED_TEXT = `Вы заблокированы в поддержке. Обжаловать можно в Discord: ${DISCORD}`;
const CLOSED = `Сообщения по ней больше не принимаются. Остался вопрос: пишите в Discord ${DISCORD}.`;

export const STATUS = {
  new: '🆕 Новая',
  in_progress: '🔄 На рассмотрении',
  done: '✅ Выдано',
  rejected: '❌ Отказано',
};

const DONE_TEXT = {
  privilege: 'Привилегию выдадут в течение дня.',
  donate: 'Проверка займёт от 1 до 3 дней. Обычно после неё кредиты появляются на балансе.',
};

const PLAYER_STATUS = {
  in_progress: (r) => `🔄 Заявку #${r.id} взяли на рассмотрение.`,
  done: (r) => `✅ Заявка #${r.id}: ${r.type === 'privilege' ? 'привилегия выдана' : 'донат выдан'}.\n${CLOSED}`,
  rejected: (r) => `❌ Заявку #${r.id} отклонили.\n${CLOSED}`,
};

// ── Тексты анкеты ────────────────────────────────────────────────────
// Пишем коротко: игроки - в основном школьники, длинный текст не дочитывают.

// Условия возврата привилегии - по странице на мысль. «Подходит» только на
// последней: чтобы до неё дойти, придётся пролистать все.
const GUIDE = [
  `<b>Когда возвращаем привилегию</b> (1/4)

Вернём в одном из трёх случаев:
1. У вас была донатная админка, вы ушли в наборные админы, а теперь вас сняли с наборки.
2. Система сняла админку за спам ULX-командами, а вы ничего не сливали.
3. Вас сняли по лимиту в 5 варнов, но на этой админке вы столько не получали: варны перешли со старой.`,

  `<b>Когда не возвращаем</b> (2/4)

• У вас VIP. Возвращаем только донатные админки, от д-модера и выше.
• Прошло больше полугода. Для наборных считаем со дня, когда сняли с наборки.
• Сняли с одной админки, а вернуть хотите другую, более старую.
• Нет лога покупок.

Отказать могут и по другой причине.`,

  `<b>Где взять лог покупок</b> (3/4)

В игре нажмите F4 → Донат → иконка профиля справа сверху → Все логи. Сделайте скриншот всего экрана, где видна покупка этой привилегии.

Покупали не через F4 или обновлялись? Подойдёт скриншот переписки с Артуром.
Если покупка давняя, могут попросить ещё скриншоты, прокрученные выше.`,

  `<b>Всё подходит?</b> (4/4)

Жмите «Подходит», если ваш случай есть на первой странице и у вас есть скриншот лога покупок на весь экран, без обрезки.`,
];

const guidePage = (n) => ({
  text: GUIDE[n],
  buttons: [[
    ...(n > 0 ? [btn('← Назад', `gp:${n - 1}`)] : []),
    n < GUIDE.length - 1 ? btn('Дальше →', `gp:${n + 1}`) : btn('✅ Подходит', 'gate'),
  ]],
});

const DONATE_INTRO = `<b>Не пришёл донат</b>
Мы проверим платёж вручную.

Каким способом вы платили на сайте?`;

const STEAM_ASK = `Напишите ваш SteamID. Пример: <code>STEAM_0:0:43836629</code>

Как узнать: зайдите на сервер, откройте TAB, найдите себя и нажмите «Скопировать SteamID».`;

const STEAM_MISSING = 'В Steam нет профиля с таким ID. Проверьте его: в игре откройте консоль и введите <code>status</code>.';

const SHOT_ASK = 'Пришлите скриншот лога покупок. На нём должен быть весь экран, от угла до угла. Обрезанные скриншоты и фото монитора не принимаем.';

const RECEIPT_ASK = 'Пришлите чек из банка или платёжной системы. На нём должны быть видны сумма и время платежа. Подойдёт картинка или PDF.';

// ── Мелочи ───────────────────────────────────────────────────────────

export const esc = (value) =>
  String(value ?? '-').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function btn(text, callback_data) {
  return { text, callback_data };
}

// Варианты кнопками. В callback_data - номер, а не текст: лимит там 64 байта,
// а кириллица - два байта на букву.
const choices = (items, p) => items.map((text, i) => [btn(text, `${p}:${i}`)]);
const pick = (data, p, items) => {
  const i = data?.startsWith(`${p}:`) ? data.slice(p.length + 1) : '';
  return /^\d+$/.test(i) ? items[i] : undefined;
};

// ГГГГ-ММ-ДД московского дня - тот формат, который ждёт v.paidAt.
const mskDate = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });

// Игроки пишут дату по-русски, но и ГГГГ-ММ-ДД примем.
export const parseDate = (text) => {
  const s = String(text ?? '').trim();
  const ru = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (ru) return `${ru[3]}-${ru[2].padStart(2, '0')}-${ru[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const fmtDate = (d) =>
  new Date(String(d).length === 10 ? `${d}T00:00:00+03:00` : d)
    .toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

const shortDate = (t) =>
  new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });

// Поля заявки - общие для сводки игроку и карточки админа. d - черновик
// анкеты или строка из базы: имена полей у них совпадают.
const fields = (d) => [
  ...(d.type === 'privilege'
    ? [`Причина: ${esc(d.reason)}`]
    : [
        `Сумма: <b>${esc(d.amount)}</b> кредитов`,
        `Оплата: ${esc(d.payment_method)}`,
        `Дата: ${fmtDate(d.paid_at)} (МСК)`,
      ]),
  `SteamID: <code>${esc(d.steam_id)}</code>`
    + (v.STEAM_ID_CANON.test(d.steam_id) ? '' : ' ⚠ не STEAM_0, проверьте'),
  ...(d.server ? [`Сервер: ${esc(d.server)}`] : []),
  ...(d.comment ? [`Коммент: ${esc(d.comment)}`] : []),
];

const TITLE = { privilege: '🟣 <b>ВЕРНУТЬ ПРИВИЛЕГИЮ', donate: '🟡 <b>НЕ ПРИШЁЛ ДОНАТ' };

export const card = (row, blocked = false) => [
  `${TITLE[row.type]} · #${row.id}</b>`,
  `Статус: ${STATUS[row.status] ?? esc(row.status)}`,
  ...fields(row),
  row.telegram_id
    ? `Telegram: <a href="tg://user?id=${row.telegram_id}">${esc(row.telegram_name)}</a> · id <code>${row.telegram_id}</code>`
    : `Discord: <code>${esc(row.discord)}</code> · id <code>${esc(row.discord_id)}</code> (с сайта)`,
  ...(row.screenshot_url ? [`<a href="${esc(row.screenshot_url)}">Скриншот</a>`] : []),
  ...(blocked ? ['🚫 Игрок заблокирован'] : []),
  ...(row.telegram_id ? ['', '<i>«💬 Ответить» или Reply на это сообщение - ответ уйдёт игроку.</i>'] : []),
].join('\n');

export const cardKb = (row, blocked) => [
  ['in_progress', 'done', 'rejected'].map((s) =>
    btn((row.status === s ? '• ' : '') + STATUS[s], `st:${row.id}:${s}`)),
  ...(row.telegram_id
    ? [[
        btn('💬 Ответить', `rp:${row.id}`),
        btn(blocked ? '✅ Разблокировать' : '🚫 Заблокировать', `bl:${row.id}`),
      ]]
    : []),
];

const welcome = () => ({
  text: `Что случилось? Выберите:

<i>Другой вопрос? Пишите в Discord: ${DISCORD}</i>`,
  buttons: [[btn('Нужно вернуть привилегию', 't:privilege')], [btn('Не пришёл донат', 't:donate')]],
});

// ── Анкета ───────────────────────────────────────────────────────────
// take() возвращает:
//   undefined        - ввод не того вида (текст вместо кнопки и т.п.)
//   { error }        - ввод того вида, но неверный
//   { set, note }    - принято, дальше следующий шаг
//   { show }         - остаться на шаге и перерисовать нажатое сообщение
//   { end }          - анкета закончена без заявки
//   { submit: true } - отправить

const STEPS = {
  gate: {
    ask: () => guidePage(0),
    hint: 'Листайте кнопками под сообщением выше.',
    take: ({ data }) => {
      if (data === 'gate') return { set: {} };
      const page = data?.match(/^gp:(\d)$/)?.[1];
      return page && GUIDE[page] ? { show: guidePage(Number(page)) } : undefined;
    },
  },
  method: {
    ask: () => ({ text: DONATE_INTRO, buttons: choices(v.PAYMENT_METHODS, 'm') }),
    hint: 'Выберите способ оплаты кнопкой.',
    take: ({ data }) => {
      const method = pick(data, 'm', v.PAYMENT_METHODS);
      if (!method) return undefined;
      if (v.acceptsForm(method)) return { set: { payment_method: method } };
      const { name, url } = v.EXTERNAL_SUPPORT[method];
      return {
        end: {
          text: 'Этот способ оплаты проверяем не мы, а поддержка платёжной системы. Напишите им:',
          buttons: [[{ text: name, url }]],
        },
      };
    },
  },
  steam: {
    ask: () => ({ text: STEAM_ASK }),
    hint: 'Напишите SteamID сообщением.',
    take: async ({ text }, d, now, deps) => {
      if (!text) return undefined;
      const id = text.toUpperCase();
      if (!v.steamId(id)) return { error: 'Не похоже на SteamID. Нужно так: <code>STEAM_0:0:43836629</code>' };
      if (deps.steamExists && !(await deps.steamExists(id))) return { error: STEAM_MISSING };
      const note = v.steamIdNote(id);
      return { set: { steam_id: id }, note: note && `⚠ ${note}` };
    },
  },
  server: {
    ask: () => ({ text: 'На каком сервере?', buttons: choices(v.SERVERS, 's') }),
    hint: 'Выберите сервер кнопкой.',
    take: ({ data }) => {
      const server = pick(data, 's', v.SERVERS);
      return server && { set: { server } };
    },
  },
  reason: {
    ask: () => ({ text: 'Почему пропала привилегия?', buttons: choices(v.REASONS, 'r') }),
    hint: 'Выберите причину кнопкой.',
    take: ({ data }) => {
      const reason = pick(data, 'r', v.REASONS);
      return reason && { set: { reason } };
    },
  },
  amount: {
    ask: () => ({ text: 'Сколько кредитов вы купили? Пишите число кредитов без комиссии. Например: <code>300</code>' }),
    hint: 'Напишите число кредитов.',
    take: ({ text }) => {
      if (!text) return undefined;
      const n = text.replace(/\s/g, '');
      return v.amount(n) ? { set: { amount: Number(n) } } : { error: 'Нужно целое число кредитов, больше нуля.' };
    },
  },
  paid: {
    ask: () => ({
      text: 'Когда платили? Дата по Москве, например <code>05.08.2026</code>. Или нажмите кнопку.',
      buttons: [[btn('Сегодня', 'd:0'), btn('Вчера', 'd:1')]],
    }),
    hint: 'Напишите дату, например <code>05.08.2026</code>, или нажмите кнопку.',
    take: ({ text, data }, d, now) => {
      const day = data?.match(/^d:([01])$/)?.[1];
      if (!day && !text) return undefined;
      const date = day ? mskDate(now - Number(day) * 864e5) : parseDate(text);
      return v.paidAt(date, now)
        ? { set: { paid_at: date } }
        : { error: 'Не понял дату. Пишите так: <code>05.08.2026</code>. Не позже сегодня и не раньше, чем год назад.' };
    },
  },
  file: {
    ask: (d) => ({ text: d.type === 'privilege' ? SHOT_ASK : RECEIPT_ASK }),
    hint: 'Пришлите скриншот: фото или файл.',
    take: ({ file }, d) => {
      if (!file) return undefined;
      // Фото принимаем как есть: Telegram жмёт его, но текст обычно читается.
      if (file.kind === 'photo') return { set: { file_id: file.id, file_kind: 'photo' } };
      const ok = file.mime?.startsWith('image/') || (d.type === 'donate' && file.mime === v.PDF);
      return ok
        ? { set: { file_id: file.id, file_kind: 'document' } }
        : { error: d.type === 'donate' ? 'Нужна картинка или PDF с чеком.' : 'Нужна картинка со скриншотом лога покупок.' };
    },
  },
  comment: {
    ask: () => ({ text: 'Хотите что-то добавить? Напишите или нажмите «Пропустить».', buttons: [[btn('Пропустить', 'skip')]] }),
    hint: 'Напишите комментарий или нажмите «Пропустить».',
    take: ({ text, data }) => {
      if (data === 'skip') return { set: { comment: null } };
      if (!text) return undefined;
      return text.length > 500 ? { error: 'Слишком длинно, уложитесь в 500 символов.' } : { set: { comment: text } };
    },
  },
  confirm: {
    ask: (d) => ({
      text: ['<b>Проверьте заявку</b>', '', ...fields(d), 'Скриншот: приложен'].join('\n'),
      buttons: [[btn('📨 Отправить', 'send'), btn('↺ Заново', 'again')]],
    }),
    hint: 'Нажмите «Отправить» или «Заново».',
    take: ({ data }) => (data === 'send' ? { submit: true } : undefined),
  },
};

export const FLOW = {
  privilege: ['gate', 'steam', 'server', 'reason', 'file', 'comment', 'confirm'],
  donate: ['method', 'steam', 'server', 'amount', 'paid', 'file', 'comment', 'confirm'],
};

// Вопрос анкеты с кнопкой отмены под ним.
const withCancel = (r) => ({ ...r, buttons: [...(r.buttons ?? []), [btn('✖ Отмена', 'cancel')]] });
const ask = (name, d, now) => withCancel(STEPS[name].ask(d, now));

// state: null | { step, draft }. input: { text?, data?, file? }.
// Возвращает { state, replies, submit? } - submit это готовый черновик.
// Ответ с edit: true перерисовывает сообщение, кнопку которого нажали.
export async function step(state, input = {}, now = Date.now(), deps = {}) {
  const text = input.text?.trim();
  const { data, file } = input;
  const command = text?.startsWith('/') ? text.split(/[\s@]/)[0] : null;

  if (command === '/start' || data === 'again') return { state: null, replies: [welcome()] };
  if (command === '/cancel' || data === 'cancel') {
    return { state: null, replies: [{ text: 'Анкета отменена.', buttons: [[btn(NEW_BUTTON, 'again')]] }] };
  }

  const type = data?.startsWith('t:') ? data.slice(2) : null;
  if (FLOW[type]) {
    const first = FLOW[type][0];
    const draft = { type };
    return { state: { step: first, draft }, replies: [ask(first, draft, now)] };
  }

  // Старая кнопка после истёкшей анкеты.
  if (!state || !STEPS[state.step]) return { state: null, replies: [welcome()] };

  const s = STEPS[state.step];
  const r = await s.take({ text, data, file }, state.draft, now, deps);

  // Ввод не того вида: на текст и файлы - короткая подсказка (вопрос с
  // кнопками и так выше), на чужую кнопку - вопрос заново, кнопки под ним.
  if (!r) return { state, replies: [data ? ask(state.step, state.draft, now) : { text: s.hint }] };
  if (r.error) return { state, replies: [{ text: r.error }] };
  if (r.show) return { state, replies: [{ ...withCancel(r.show), edit: true }] };
  if (r.end) return { state: null, replies: [r.end] };
  if (r.submit) return { state, replies: [], submit: state.draft };

  const draft = { ...state.draft, ...r.set };
  const flow = FLOW[draft.type];
  const next = flow[flow.indexOf(state.step) + 1];
  return {
    state: { step: next, draft },
    replies: [...(r.note ? [{ text: r.note }] : []), ask(next, draft, now)],
  };
}

// ── Telegram и Supabase ──────────────────────────────────────────────

export const tg = async (method, body) => {
  const response = await fetch(`https://api.telegram.org/bot${env().TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
};

// Повторное редактирование тем же текстом Telegram считает ошибкой - это не она.
const notModified = (error) => {
  if (!/not modified/.test(error.message)) throw error;
};

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

export const send = (chat_id, { text, buttons }, extra = {}) =>
  tg('sendMessage', {
    chat_id,
    text,
    ...HTML,
    ...(buttons && { reply_markup: { inline_keyboard: buttons } }),
    ...extra,
  });

const react = (chat_id, message_id) =>
  tg('setMessageReaction', { chat_id, message_id, reaction: [{ type: 'emoji', emoji: '👍' }] })
    .catch((error) => console.error('reaction', error));

const sb = (path, init = {}) =>
  fetch(`${env().SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: env().SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env().SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

export const sbJson = async (path, init) => {
  const response = await sb(path, init);
  if (!response.ok) throw new Error(`supabase ${init?.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
};

export const admins = () =>
  String(env().ADMIN_IDS || env().TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
export const isAdmin = (chat) => admins().includes(String(chat));

// Самый дешёвый фильтр выдуманных заявок: у выдуманного SteamID нет профиля в
// Steam. Ключа нет или Steam не ответил - считаем, что не знаем, и пропускаем:
// чужая недоступность не повод терять живого игрока.
const steamExists = async (id) => {
  if (!env().STEAM_API_KEY) return true;
  try {
    const response = await fetch(
      'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/'
        + `?key=${env().STEAM_API_KEY}&steamids=${v.steamId64(id)}`,
    );
    if (!response.ok) return true;
    const { response: { players } = {} } = await response.json();
    return !players || players.length > 0;
  } catch {
    return true;
  }
};

const loadState = async (chat) => {
  const [row] = await sbJson(`/rest/v1/tg_state?chat_id=eq.${chat}&select=step,draft,updated_at`);
  const ttl = row?.step === 'reply' ? REPLY_TTL : STATE_TTL;
  return row && Date.now() - Date.parse(row.updated_at) < ttl ? { step: row.step, draft: row.draft } : null;
};

const saveState = (chat, state) =>
  state
    ? sbJson('/rest/v1/tg_state', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ chat_id: chat, step: state.step, draft: state.draft, updated_at: new Date().toISOString() }),
      })
    : sbJson(`/rest/v1/tg_state?chat_id=eq.${chat}`, { method: 'DELETE' });

export const getRow = async (id) => (await sbJson(`/rest/v1/requests?id=eq.${id}&select=*`))[0];

export const isBlocked = async (telegramId) =>
  (await sbJson(`/rest/v1/tg_blocked?telegram_id=eq.${telegramId}&select=telegram_id`)).length > 0;

const countSince = async (telegramId, since) => {
  const response = await sb(
    `/rest/v1/requests?telegram_id=eq.${telegramId}&created_at=gte.${since}&select=id`,
    { method: 'HEAD', headers: { Prefer: 'count=exact', Range: '0-0' } },
  );
  return Number(response.headers.get('content-range')?.split('/')[1] ?? 0);
};

const thread = (chat, messageIds, requestId) =>
  sbJson('/rest/v1/tg_thread', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify(messageIds.map((id) => ({ admin_chat_id: chat, admin_msg_id: id, request_id: requestId }))),
  });

const MEDIA = ['photo', 'document', 'voice', 'video', 'audio', 'animation', 'video_note', 'sticker'];

// Файл любого вида из сообщения: у фото это массив размеров, крупнейший - последний.
const mediaOf = (msg) => {
  for (const kind of MEDIA) {
    const media = msg[kind];
    if (media) return { tg_file_id: (Array.isArray(media) ? media.at(-1) : media).file_id, tg_file_kind: kind };
  }
  return {};
};

// Переписка в базу: в Telegram её историю не прочитать, а панели на сайте она
// нужна. Сбой записи не роняет доставку - сообщение уже ушло адресату.
export const logMessage = (requestId, row) =>
  sbJson('/rest/v1/messages', { method: 'POST', body: JSON.stringify({ request_id: requestId, ...row }) })
    .catch((error) => console.error('log message', error));

// Когда игрок написал последний раз. Панель сравнивает с last_seen_at и
// показывает непрочитанное.
const touchPlayerAt = (requestId) =>
  sbJson(`/rest/v1/requests?id=eq.${requestId}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_player_at: new Date().toISOString() }),
  }).catch((error) => console.error('last_player_at', error));

const threadRequest = async (chat, messageId) =>
  (await sbJson(`/rest/v1/tg_thread?admin_chat_id=eq.${chat}&admin_msg_id=eq.${messageId}&select=request_id`))[0]?.request_id;

// Первое сообщение заявки в чате админа - это карточка: к ней и цепляем переписку.
export const cardMessage = async (chat, requestId) =>
  (await sbJson(
    `/rest/v1/tg_thread?admin_chat_id=eq.${chat}&request_id=eq.${requestId}&select=admin_msg_id&order=admin_msg_id.asc&limit=1`,
  ))[0]?.admin_msg_id;

// Карточка - текстом (лимит 4096, а у подписи к файлу всего 1024), файл -
// ответом на неё. Оба сообщения в tg_thread: ответить игроку можно на любое.
const postCard = async (chat, row) => {
  const blocked = row.telegram_id ? await isBlocked(row.telegram_id) : false;
  const msg = await send(chat, { text: card(row, blocked), buttons: cardKb(row, blocked) });
  const ids = [msg.message_id];
  if (row.tg_file_id) {
    const kind = row.tg_file_kind === 'photo' ? 'photo' : 'document';
    const file = await tg(kind === 'photo' ? 'sendPhoto' : 'sendDocument', {
      chat_id: chat,
      [kind]: row.tg_file_id,
      reply_parameters: { message_id: msg.message_id },
    });
    ids.push(file.message_id);
  }
  await thread(chat, ids, row.id);
};

// Перерисовать сообщение с кнопками тем же { text, buttons }, что шлёт send().
const editTo = (chat, messageId, { text, buttons }) =>
  tg('editMessageText', {
    chat_id: chat,
    message_id: messageId,
    text,
    ...HTML,
    reply_markup: { inline_keyboard: buttons ?? [] },
  }).catch(notModified);

// Карточки заявки во всех чатах админов - перерисовать после правки.
// pressed - сообщение, кнопку которого нажали: это может быть копия карточки,
// открытая из списка, а не первая.
const refreshCards = async (row, blocked, pressed) => {
  const targets = [];
  const seen = new Set();
  const add = (chat, messageId) => {
    const key = `${chat}:${messageId}`;
    if (!messageId || seen.has(key)) return;
    seen.add(key);
    targets.push([chat, messageId]);
  };
  for (const admin of admins()) add(admin, await cardMessage(admin, row.id));
  if (pressed) add(pressed.chat.id, pressed.message_id);

  for (const [chat, messageId] of targets) {
    await editTo(chat, messageId, { text: card(row, blocked), buttons: cardKb(row, blocked) })
      .catch((error) => console.error('card refresh', chat, error));
  }
};

// Копия сообщения с заголовком «от кого». Текст пересобираем, чтобы вписать
// заголовок; всё остальное (фото, файлы, голосовые) копирует сам Telegram.
const relay = (msg, chat, header, replyTo) => {
  const base = {
    chat_id: chat,
    parse_mode: 'HTML',
    ...(replyTo && { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
  };
  if (msg.text) {
    return tg('sendMessage', { ...base, text: `${header}\n${esc(msg.text.slice(0, 3800))}`, link_preview_options: { is_disabled: true } });
  }
  const captioned = msg.photo || msg.document || msg.video || msg.audio || msg.voice || msg.animation;
  return tg('copyMessage', {
    ...base,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
    ...(captioned && { caption: header + (msg.caption ? `\n${esc(msg.caption.slice(0, 900))}` : '') }),
  });
};

const nameOf = (from) =>
  from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ');

// ── Игрок ────────────────────────────────────────────────────────────

const submit = async (chat, from, d) => {
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const dayAgo = new Date(Date.now() - 86400e3).toISOString();
  if ((await countSince(from.id, hourAgo)) >= PER_HOUR || (await countSince(from.id, dayAgo)) >= PER_DAY) {
    // Черновик не трогаем: позже игрок нажмёт «Отправить» ещё раз.
    return send(chat, { text: 'Слишком много заявок подряд. Попробуйте позже.' });
  }

  const [row] = await sbJson('/rest/v1/requests', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      type: d.type,
      steam_id: d.steam_id,
      server: d.server,
      reason: d.type === 'privilege' ? d.reason : null,
      amount: d.type === 'donate' ? d.amount : null,
      payment_method: d.type === 'donate' ? d.payment_method : null,
      // Дата означает московский день - закрепляем смещением, иначе UTC
      // сдвинет её на сутки назад.
      paid_at: d.type === 'donate' ? new Date(`${d.paid_at}T00:00:00+03:00`).toISOString() : null,
      comment: d.comment || null,
      telegram_id: from.id,
      telegram_name: nameOf(from),
      tg_file_id: d.file_id,
      tg_file_kind: d.file_kind,
      source: 'tg',
    }),
  });
  await saveState(chat, null);

  await send(chat, {
    text: `✅ <b>Заявка #${row.id} отправлена</b>
${DONE_TEXT[row.type]}

Ответ придёт сюда. Если хотите что-то добавить, просто напишите.`,
  });

  // Заявка уже сохранена: сбой у одного админа не мешает остальным.
  for (const admin of admins()) {
    await postCard(admin, row).catch((error) => console.error('card', admin, error));
  }
};

// Сообщение вне анкеты - переписка по последней открытой заявке игрока.
// По закрытой (Выдано/Отказано) сообщения не принимаются.
// ponytail: всегда последняя открытая; выбор заявки, если понадобится вести две сразу.
const playerMessage = async (msg) => {
  const [row] = await sbJson(
    `/rest/v1/requests?telegram_id=eq.${msg.from.id}&status=in.(new,in_progress)&select=id&order=id.desc&limit=1`,
  );
  if (!row) {
    const [last] = await sbJson(`/rest/v1/requests?telegram_id=eq.${msg.from.id}&select=id&order=id.desc&limit=1`);
    if (!last) return send(msg.chat.id, welcome());
    return send(msg.chat.id, { text: `Заявка #${last.id} закрыта. ${CLOSED}` });
  }

  await logMessage(row.id, { from_admin: false, text: msg.text ?? msg.caption ?? null, ...mediaOf(msg), via: 'tg' });
  await touchPlayerAt(row.id);

  const header = `💬 <b>#${row.id} · ${esc(nameOf(msg.from))}</b>`;
  let delivered = false;
  for (const admin of admins()) {
    try {
      const sent = await relay(msg, admin, header, await cardMessage(admin, row.id));
      await thread(admin, [sent.message_id], row.id);
      delivered = true;
    } catch (error) {
      console.error('relay to admin', admin, error);
    }
  }
  if (delivered) await react(msg.chat.id, msg.message_id);
  else await send(msg.chat.id, { text: 'Не получилось отправить. Попробуйте чуть позже.' });
};

const myRequests = async (chat, from) => {
  const rows = await sbJson(
    `/rest/v1/requests?telegram_id=eq.${from.id}&select=id,type,status,created_at&order=id.desc&limit=10`,
  );
  return send(chat, {
    text: rows.length
      ? ['<b>Ваши заявки</b>', '', ...rows.map((r) =>
          `#${r.id} · ${r.type === 'privilege' ? 'привилегия' : 'донат'} · ${STATUS[r.status] ?? esc(r.status)} · ${shortDate(r.created_at)}`,
        )].join('\n')
      : 'У вас пока нет заявок.',
    buttons: [[btn(NEW_BUTTON, 'again')]],
  });
};

// ── Админ ────────────────────────────────────────────────────────────

const FILTERS = { new: '🆕 Новые', in_progress: '🔄 В работе', done: '✅ Выданы', rejected: '❌ Отказаны', all: 'Все' };

// Заголовок ответа админа. Один на бота и панель, чтобы игрок видел одно и то же.
export const supportHeader = (id) => `💬 <b>Поддержка · заявка #${id}</b>`;

// Сообщение админа - игроку заявки. true - доставлено. Блокировка игрока
// ответам не мешает: она закрывает только его сторону.
const replyToPlayer = async (msg, requestId) => {
  const chat = msg.chat.id;
  const row = await getRow(requestId);
  if (!row?.telegram_id) {
    await send(chat, { text: `Заявка #${requestId} с сайта - игрока нет в боте. Discord: <code>${esc(row?.discord)}</code>` });
    return false;
  }
  try {
    await relay(msg, row.telegram_id, supportHeader(row.id));
  } catch (error) {
    const why = /blocked|deactivated|chat not found/.test(error.message)
      ? 'игрок заблокировал бота или удалил аккаунт'
      : esc(error.message);
    await send(chat, { text: `Не доставлено: ${why}` }, { reply_parameters: { message_id: msg.message_id } });
    return false;
  }
  await logMessage(row.id, {
    from_admin: true,
    admin_id: msg.from.id,
    text: msg.text ?? msg.caption ?? null,
    ...mediaOf(msg),
    via: 'tg',
  });
  await thread(chat, [msg.message_id], row.id);
  await react(chat, msg.message_id);
  return true;
};

// Reply на карточку, файл или сообщение игрока.
const adminReply = async (msg) => {
  const requestId = await threadRequest(msg.chat.id, msg.reply_to_message.message_id);
  if (!requestId) {
    return send(msg.chat.id, { text: 'Это сообщение не относится к заявке. Нажмите «💬 Ответить» на карточке или ответьте (Reply) на сообщение игрока.' });
  }
  return replyToPlayer(msg, requestId);
};

// Ссылка на панель на сайте. PANEL_URL не задан - кнопки просто нет.
const panelLink = () =>
  env().PANEL_URL ? [[{ text: '🖥 Открыть панель на сайте', url: env().PANEL_URL }]] : [];

const panel = async (filter, offset) => {
  const f = FILTERS[filter] ? filter : 'new';
  const rows = await sbJson(
    '/rest/v1/requests?select=id,type,status,steam_id,created_at&order=id.desc'
      + `&limit=${PAGE + 1}&offset=${offset}${f === 'all' ? '' : `&status=eq.${f}`}`,
  );
  const mark = (key) => btn((key === f ? '• ' : '') + FILTERS[key], `ls:${key}:0`);
  const nav = [
    ...(offset > 0 ? [btn('◀', `ls:${f}:${Math.max(0, offset - PAGE)}`)] : []),
    ...(rows.length > PAGE ? [btn('▶', `ls:${f}:${offset + PAGE}`)] : []),
  ];
  return {
    text: `<b>Заявки · ${FILTERS[f]}</b>${offset ? ` · с ${offset + 1}-й` : ''}${rows.length ? '' : '\n\nПусто.'}`,
    buttons: [
      ...panelLink(),
      [mark('new'), mark('in_progress')],
      [mark('done'), mark('rejected'), mark('all')],
      [btn('🚫 Заблокированные', 'bk')],
      ...rows.slice(0, PAGE).map((r) => [btn(
        `${STATUS[r.status]?.split(' ')[0] ?? ''} #${r.id} ${r.type === 'privilege' ? 'привилегия' : 'донат'} · ${r.steam_id} · `
          + shortDate(r.created_at),
        `rq:${r.id}`,
      )]),
      ...(nav.length ? [nav] : []),
    ],
  };
};

// Смена статуса: база, уведомление игроку, перерисовка карточек. Один код на
// два входа - кнопку в боте и панель на сайте, иначе логика разъедется.
// Возвращает { error } либо { row, text } - text годится и в ответ на нажатие.
export const applyStatus = async (id, status, pressed) => {
  if (!['in_progress', 'done', 'rejected'].includes(status)) return { error: 'Неизвестный статус' };
  const row = await getRow(id);
  if (!row) return { error: 'Заявка не найдена' };
  if (row.status === status) return { error: 'Статус уже такой' };

  const [updated] = await sbJson(`/rest/v1/requests?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status }),
  });
  await refreshCards(updated, updated.telegram_id ? await isBlocked(updated.telegram_id) : false, pressed);

  if (!updated.telegram_id) return { row: updated, text: `${STATUS[status]} · игрок с сайта, уведомления нет` };
  try {
    await send(updated.telegram_id, { text: PLAYER_STATUS[status](updated) });
    return { row: updated, text: STATUS[status] };
  } catch (error) {
    console.error('status notify', error);
    return { row: updated, text: `${STATUS[status]} · игрок не получил уведомление (заблокировал бота?)` };
  }
};

export const applyBlock = async (id, pressed) => {
  const row = await getRow(id);
  if (!row?.telegram_id) return { error: 'Игрока этой заявки нет в боте' };
  if (isAdmin(row.telegram_id)) return { error: 'Админа заблокировать нельзя' };
  const blocked = await isBlocked(row.telegram_id);
  await (blocked
    ? sbJson(`/rest/v1/tg_blocked?telegram_id=eq.${row.telegram_id}`, { method: 'DELETE' })
    : sbJson('/rest/v1/tg_blocked', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify({ telegram_id: row.telegram_id }),
      }));
  await refreshCards(row, !blocked, pressed);
  return { blocked: !blocked, text: blocked ? '✅ Игрок разблокирован' : '🚫 Игрок заблокирован' };
};

// Список заблокированных с кнопкой разблокировки у каждого. Имя - из
// последней заявки игрока.
// ponytail: первые 50 без листания; листание, если заблокированных станет больше.
const blockedList = async () => {
  const rows = await sbJson('/rest/v1/tg_blocked?select=telegram_id,blocked_at&order=blocked_at.desc&limit=50');
  const names = new Map();
  if (rows.length) {
    const reqs = await sbJson(
      `/rest/v1/requests?telegram_id=in.(${rows.map((r) => r.telegram_id).join(',')})&select=telegram_id,telegram_name&order=id.asc`,
    );
    for (const r of reqs) names.set(String(r.telegram_id), r.telegram_name); // по возрастанию id: последняя заявка перезапишет
  }
  const name = (id) => names.get(String(id)) || `id ${id}`;
  return {
    text: rows.length
      ? ['<b>🚫 Заблокированные</b>', '', ...rows.map((r) =>
          `• ${esc(name(r.telegram_id))} · id <code>${r.telegram_id}</code> · с ${shortDate(r.blocked_at)}`)].join('\n')
      : '<b>🚫 Заблокированные</b>\n\nНикого нет.',
    buttons: [
      ...rows.map((r) => [btn(`✅ Разблокировать ${name(r.telegram_id)}`, `ub:${r.telegram_id}`)]),
      [btn('← К заявкам', 'ls:new:0')],
    ],
  };
};

// «💬 Ответить»: следующее сообщение админа уйдёт игроку - одно.
const startReply = async (chat, id) => {
  const row = await getRow(id);
  if (!row?.telegram_id) return 'Игрока этой заявки нет в боте';
  await saveState(chat, { step: 'reply', draft: { request_id: row.id } });
  await send(chat, {
    text: `✍ Напишите сообщение игроку по заявке #${row.id} - текст, фото или файл. Уйдёт одним сообщением.`,
    buttons: [[btn('✖ Отмена', 'rpx')]],
  });
  return undefined;
};

const COMMANDS = [
  { command: 'start', description: 'Подать заявку' },
  { command: 'my', description: 'Мои заявки' },
  { command: 'cancel', description: 'Отменить анкету' },
];

// Меню команд. У админов своё, с панелью: игроки его не видят.
const setCommands = () =>
  Promise.all([
    tg('setMyCommands', { commands: COMMANDS }),
    ...admins().map((id) => tg('setMyCommands', {
      commands: [...COMMANDS, { command: 'panel', description: 'Панель заявок' }],
      scope: { type: 'chat', chat_id: id },
    })),
  ]).catch((error) => console.error('commands', error));

const keyboard = (admin) => ({
  keyboard: admin
    ? [[{ text: PANEL_BUTTON }], [{ text: NEW_BUTTON }, { text: MY_BUTTON }]]
    : [[{ text: NEW_BUTTON }, { text: MY_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
});

// ── Вход ─────────────────────────────────────────────────────────────

// pressed - сообщение, кнопку которого нажали (для нажатий, не для текста).
const runStep = async (chat, from, state, input, pressed) => {
  const r = await step(state, input, Date.now(), { steamExists });
  // Кнопки анкеты одноразовые: убираем их, чтобы старую не нажали позже.
  // Кроме листания условий - там перерисовывается то же сообщение.
  if (pressed && !r.replies[0]?.edit) {
    await tg('editMessageReplyMarkup', { chat_id: chat, message_id: pressed.message_id }).catch(() => {});
  }
  if (r.submit) return submit(chat, from, r.submit);
  if (state || r.state) await saveState(chat, r.state);
  for (const reply of r.replies) {
    if (reply.edit && pressed) await editTo(chat, pressed.message_id, reply);
    else await send(chat, reply);
  }
};

const fileOf = (msg) =>
  msg.document
    ? { id: msg.document.file_id, kind: 'document', mime: msg.document.mime_type }
    : msg.photo
      ? { id: msg.photo.at(-1).file_id, kind: 'photo' } // последний размер - самый крупный
      : undefined;

const onMessage = async (msg) => {
  const chat = msg.chat.id;
  const admin = isAdmin(chat);
  const text = msg.text;
  const command = text?.startsWith('/') ? text.split(/[\s@]/)[0] : null;

  let state = await loadState(chat);

  // Reply тоже снимает режим ответа - иначе следующее обычное сообщение
  // ушло бы игроку вдогонку.
  if (admin && msg.reply_to_message) {
    if (state?.step === 'reply') await saveState(chat, null);
    return adminReply(msg);
  }

  // Режим ответа: одно сообщение уходит игроку. Команда или кнопка снимает
  // режим и выполняется как обычно - кнопка панели не должна улететь игроку.
  if (admin && state?.step === 'reply') {
    await saveState(chat, null);
    if (!command && !BUTTONS.includes(text)) {
      const id = state.draft.request_id;
      if (await replyToPlayer(msg, id)) await send(chat, { text: `Отправлено игроку по заявке #${id}.` });
      return;
    }
    state = null;
  }

  if (admin && (command === '/panel' || text === PANEL_BUTTON)) return send(chat, await panel('new', 0));
  // «Мои заявки» анкету не сбрасывает: посмотрел и продолжил.
  if (command === '/my' || text === MY_BUTTON) return myRequests(chat, msg.from);

  if (command === '/start') {
    if (admin) await setCommands();
    await send(chat, {
      text: admin
        ? 'Вы админ: заявки приходят сюда сами.\n«📋 Все заявки» - панель. На карточке заявки - «💬 Ответить» и «🚫 Заблокировать».'
        : 'Здравствуйте! Это поддержка GambitRP.\nКнопки внизу: подать заявку и посмотреть свои.',
    }, { reply_markup: keyboard(admin) });
  }

  if (!state && !command && text !== NEW_BUTTON) {
    if (!admin) return playerMessage(msg);
    return send(chat, { text: 'Чтобы написать игроку, нажмите «💬 Ответить» на карточке заявки или ответьте (Reply) на его сообщение.' });
  }

  // «Подать заявку» - то же, что /start, только без приветствия.
  await runStep(chat, msg.from, state, {
    text: text === NEW_BUTTON ? '/start' : (text ?? msg.caption),
    file: fileOf(msg),
  });
};

const onCallback = async (cq) => {
  const chat = cq.message?.chat.id;
  const data = cq.data ?? '';
  let answer;
  try {
    if (!chat) return;
    const [kind, a, b] = data.split(':');
    const admin = isAdmin(chat);

    if (admin && kind === 'st') {
      const r = await applyStatus(Number(a), b, cq.message);
      answer = r.error ?? r.text;
    } else if (admin && kind === 'ls') {
      await editTo(chat, cq.message.message_id, await panel(a, Number(b) || 0));
    } else if (admin && kind === 'bk') {
      await editTo(chat, cq.message.message_id, await blockedList());
    } else if (admin && kind === 'ub' && /^\d+$/.test(a)) {
      await sbJson(`/rest/v1/tg_blocked?telegram_id=eq.${a}`, { method: 'DELETE' });
      await editTo(chat, cq.message.message_id, await blockedList());
      answer = '✅ Разблокирован';
    } else if (admin && kind === 'rq') {
      const row = await getRow(Number(a));
      if (row) await postCard(chat, row);
      else answer = 'Заявка не найдена';
    } else if (admin && kind === 'bl') {
      const r = await applyBlock(Number(a), cq.message);
      answer = r.error ?? r.text;
    } else if (admin && kind === 'rp') {
      answer = await startReply(chat, Number(a));
    } else if (admin && kind === 'rpx') {
      await saveState(chat, null);
      await tg('editMessageText', { chat_id: chat, message_id: cq.message.message_id, text: 'Ответ отменён.' }).catch(notModified);
    } else {
      await runStep(chat, cq.from, await loadState(chat), { data }, cq.message);
    }
  } finally {
    // Без ответа у кнопки крутится часик.
    await tg('answerCallbackQuery', { callback_query_id: cq.id, ...(answer && { text: answer }) }).catch(() => {});
  }
};

export async function handle(update) {
  const cq = update.callback_query;
  const msg = update.message?.chat?.type === 'private' ? update.message : null;
  const from = cq?.from ?? msg?.from;
  if (!from || (!cq && !msg)) return;

  // Заблокированному - ни анкеты, ни переписки. Админа не блокируем никогда.
  if (!isAdmin(from.id) && (await isBlocked(from.id))) {
    if (cq) {
      return tg('answerCallbackQuery', { callback_query_id: cq.id, text: BLOCKED_TEXT, show_alert: true }).catch(() => {});
    }
    return send(msg.chat.id, { text: BLOCKED_TEXT });
  }

  return cq ? onCallback(cq) : onMessage(msg);
}
