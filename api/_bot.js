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

const BLOCKED_TEXT = 'Вы заблокированы в поддержке. Обжаловать - в Discord: cheshirecat247';
const CLOSED = 'Сообщения по этой заявке больше не принимаются. Остался вопрос - подайте новую заявку.';

export const STATUS = {
  new: '🆕 Новая',
  in_progress: '🔄 На рассмотрении',
  done: '✅ Выдано',
  rejected: '❌ Отказано',
};

const DONE_TEXT = {
  privilege: 'Привилегия будет выдана в течение дня.',
  donate: 'Проверка занимает от 1 до 3 дней. По истечении проверки с большой вероятностью вы увидите кредиты у себя на балансе.',
};

const PLAYER_STATUS = {
  in_progress: (r) => `🔄 Заявка #${r.id} взята на рассмотрение.`,
  done: (r) => `✅ Заявка #${r.id}: ${r.type === 'privilege' ? 'привилегия выдана' : 'донат выдан'}.\n${CLOSED}`,
  rejected: (r) => `❌ Заявка #${r.id} отклонена.\n${CLOSED}`,
};

// ── Тексты анкеты (дословно с сайта) ─────────────────────────────────

const PRIVILEGE_GUIDE = `<b>Возврат привилегии</b>

✅ <b>Привилегию возвращаем в 3 случаях</b>
1. <b>После наборки.</b> Вы заняли пост наборного администратора, имея донатную привилегию. После снятия с наборки донатная админка подлежит восстановлению.
2. <b>Автоснятие.</b> При спаме ULX-командами система считает, что вы можете сливать админку, и снимает привилегию. Если вы не сливали админку - она будет восстановлена.
3. <b>Забыли снять варны с прошлой админки.</b> Варны перенеслись на новую привилегию и система сняла вас по лимиту (5 варнов). Если на текущей привилегии вы столько не получали - админка будет восстановлена.

⛔ <b>Привилегию НЕ возвращаем, если</b>
• это VIP - возвращаем только донатные админки от д-модера и выше;
• привилегия утеряна более полугода назад (для наборной админки отсчёт идёт с момента снятия с наборки);
• вас сняли с донатной админки, а вернуть вы пытаетесь более старую привилегию;
• отсутствует лог покупок.
<i>Отказ возможен и по причине, не указанной выше. Если привилегия куплена давно, могут понадобиться дополнительные скриншоты с прокруткой вверх.</i>

<b>Где взять лог покупок?</b> Нажмите <b>F4</b> → откройте <b>Донат</b> → справа сверху иконка профиля → <b>Все логи</b>. Сделайте скриншот с покупкой той привилегии, которую нужно вернуть. Подойдёт и скриншот переписки с Артуром, если вы обновлялись или покупали не через F4.

Нажмите кнопку, если вы прочитали условия выше, ваша ситуация подходит под один из трёх случаев, и у вас есть <b>полный, необрезанный</b> скриншот лога покупок.`;

const DONATE_INTRO = `<b>Не пришёл донат</b>
Заполните анкету - платёж будет проверен вручную.

Способ оплаты, который вы выбирали на сайте:`;

const STEAM_ASK = `Ваш SteamID, например <code>STEAM_0:0:43836629</code>

<b>Где взять?</b> Находясь на сервере, откройте <b>TAB</b>, найдите там себя и нажмите «Скопировать SteamID».`;

const STEAM_MISSING = 'Профиля с таким SteamID нет в Steam. Свой ID видно в игре в консоли по команде <code>status</code>.';

const AS_FILE = 'Отправляйте <b>файлом</b> (📎 → Файл), а не фото: Telegram сжимает фото, и мелкий текст становится нечитаемым.';

const SHOT_ASK = `Пришлите скриншот лога покупок.

Скриншот должен показывать <b>весь экран целиком, от угла до угла</b>. Обрезанные скриншоты и фотографии монитора не принимаются.

${AS_FILE}`;

const RECEIPT_ASK = `Пришлите скриншот чека или квитанции - из банка или платёжной системы, где видны сумма и время платежа. Картинкой или PDF.

${AS_FILE}`;

const PHOTO_NOTE = '⚠ Telegram сжал фото - мелкий текст может стать нечитаемым. Если так, пришлите тот же скриншот <b>файлом</b> прямо сейчас - он заменит фото. Или продолжайте.';

// ── Мелочи ───────────────────────────────────────────────────────────

export const esc = (value) =>
  String(value ?? '-').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const btn = (text, callback_data) => ({ text, callback_data });

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
  ...(row.tg_file_kind === 'photo' ? ['⚠ Telegram сжал фото - мелкий текст может не читаться'] : []),
  ...(row.screenshot_url ? [`<a href="${esc(row.screenshot_url)}">Скриншот</a>`] : []),
  ...(blocked ? ['🚫 Игрок заблокирован'] : []),
  ...(row.telegram_id ? ['', '<i>«💬 Ответить» или Reply на это сообщение - ответ уйдёт игроку.</i>'] : []),
].join('\n');

const cardKb = (row, blocked) => [
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
  text: `Выберите вашу проблему:

<i>Вопрос вне списка? Напишите в Discord - cheshirecat247</i>`,
  buttons: [[btn('Нужно вернуть привилегию', 't:privilege')], [btn('Не пришёл донат', 't:donate')]],
});

// ── Анкета ───────────────────────────────────────────────────────────
// take() возвращает:
//   undefined           - ввод не того вида (текст вместо кнопки и т.п.)
//   { error }           - ввод того вида, но неверный
//   { set, note, stay } - принято; stay - остаться на этом же шаге
//   { end }             - анкета закончена без заявки
//   { submit: true }    - отправить

const takeFile = (file, d) => {
  if (!file) return undefined;
  if (file.kind === 'photo') return { set: { file_id: file.id, file_kind: 'photo' }, note: PHOTO_NOTE };
  // Любая картинка: превью игрок видит у себя в чате, а сжимать её нам больше
  // не нужно - файл остаётся в Telegram и пересылается админу по file_id.
  const ok = file.mime?.startsWith('image/') || (d.type === 'donate' && file.mime === v.PDF);
  return ok
    ? { set: { file_id: file.id, file_kind: 'document' } }
    : { error: d.type === 'donate' ? 'Нужна картинка или PDF с чеком.' : 'Нужна картинка - скриншот лога покупок.' };
};

const STEPS = {
  gate: {
    ask: () => ({ text: PRIVILEGE_GUIDE, buttons: [[btn('✅ Подходит, продолжить', 'gate')]] }),
    hint: 'Нажмите кнопку под условиями выше.',
    take: ({ data }) => (data === 'gate' ? { set: {} } : undefined),
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
          text: `<b>Эта проблема решается не администрацией сервера</b>
По выбранному способу оплаты вопрос решает поддержка платёжной системы. Обратитесь напрямую:`,
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
      if (!v.steamId(id)) return { error: 'Формат: <code>STEAM_0:0:43836629</code>' };
      if (deps.steamExists && !(await deps.steamExists(id))) return { error: STEAM_MISSING };
      const note = v.steamIdNote(id);
      return { set: { steam_id: id }, note: note && `⚠ ${note}` };
    },
  },
  server: {
    ask: () => ({ text: 'Сервер:', buttons: choices(v.SERVERS, 's') }),
    hint: 'Выберите сервер кнопкой.',
    take: ({ data }) => {
      const server = pick(data, 's', v.SERVERS);
      return server && { set: { server } };
    },
  },
  reason: {
    ask: () => ({ text: 'Причина пропажи привилегии:', buttons: choices(v.REASONS, 'r') }),
    hint: 'Выберите причину кнопкой.',
    take: ({ data }) => {
      const reason = pick(data, 'r', v.REASONS);
      return reason && { set: { reason } };
    },
  },
  amount: {
    ask: () => ({ text: 'Точная сумма кредитов - именно кредитов, <b>без учёта комиссии</b>. Например: <code>300</code>' }),
    hint: 'Напишите сумму числом.',
    take: ({ text }) => {
      if (!text) return undefined;
      const n = text.replace(/\s/g, '');
      return v.amount(n) ? { set: { amount: Number(n) } } : { error: 'Целое число кредитов больше нуля.' };
    },
  },
  paid: {
    ask: () => ({
      text: 'Дата платежа по московскому времени - <code>ДД.ММ.ГГГГ</code>, или кнопкой:',
      buttons: [[btn('Сегодня', 'd:0'), btn('Вчера', 'd:1')]],
    }),
    hint: 'Напишите дату как <code>ДД.ММ.ГГГГ</code> или нажмите кнопку.',
    take: ({ text, data }, d, now) => {
      const day = data?.match(/^d:([01])$/)?.[1];
      if (!day && !text) return undefined;
      const date = day ? mskDate(now - Number(day) * 864e5) : parseDate(text);
      return v.paidAt(date, now)
        ? { set: { paid_at: date } }
        : { error: 'Укажите дату платежа как <code>ДД.ММ.ГГГГ</code> - не позже сегодняшнего дня и не раньше, чем год назад.' };
    },
  },
  file: {
    ask: (d) => ({ text: d.type === 'privilege' ? SHOT_ASK : RECEIPT_ASK }),
    hint: 'Пришлите файл со скриншотом.',
    take: ({ file }, d) => takeFile(file, d),
  },
  comment: {
    ask: () => ({ text: 'Комментарий - необязательно. Напишите его или нажмите «Пропустить».', buttons: [[btn('Пропустить', 'skip')]] }),
    hint: 'Напишите комментарий или нажмите «Пропустить».',
    take: ({ text, data, file }, d) => {
      // Файл здесь - это замена сжатого фото, о которой просили шагом раньше.
      if (file) {
        const r = takeFile(file, d);
        return r.error ? r : { ...r, stay: true, note: r.note ?? 'Файл заменён.' };
      }
      if (data === 'skip') return { set: { comment: null } };
      if (!text) return undefined;
      return text.length > 500 ? { error: 'Не длиннее 500 символов.' } : { set: { comment: text } };
    },
  },
  confirm: {
    ask: (d) => ({
      text: [
        '<b>Проверьте заявку</b>',
        '',
        ...fields(d),
        `Файл: ${d.file_kind === 'photo' ? 'фото (сжатое)' : 'приложен'}`,
      ].join('\n'),
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
const ask = (name, d, now) => {
  const r = STEPS[name].ask(d, now);
  return { ...r, buttons: [...(r.buttons ?? []), [btn('✖ Отмена', 'cancel')]] };
};

// state: null | { step, draft }. input: { text?, data?, file? }.
// Возвращает { state, replies, submit? } - submit это готовый черновик.
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
  if (r.end) return { state: null, replies: [r.end] };
  if (r.submit) return { state, replies: [], submit: state.draft };

  const draft = { ...state.draft, ...r.set };
  const flow = FLOW[draft.type];
  const next = r.stay ? state.step : flow[flow.indexOf(state.step) + 1];
  return {
    state: { step: next, draft },
    replies: [...(r.note ? [{ text: r.note }] : []), ask(next, draft, now)],
  };
}

// ── Telegram и Supabase ──────────────────────────────────────────────

const tg = async (method, body) => {
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

const send = (chat_id, { text, buttons }, extra = {}) =>
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

const sbJson = async (path, init) => {
  const response = await sb(path, init);
  if (!response.ok) throw new Error(`supabase ${init?.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
};

const admins = () =>
  String(env().ADMIN_IDS || env().TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
const isAdmin = (chat) => admins().includes(String(chat));

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

const getRow = async (id) => (await sbJson(`/rest/v1/requests?id=eq.${id}&select=*`))[0];

const isBlocked = async (telegramId) =>
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

const threadRequest = async (chat, messageId) =>
  (await sbJson(`/rest/v1/tg_thread?admin_chat_id=eq.${chat}&admin_msg_id=eq.${messageId}&select=request_id`))[0]?.request_id;

// Первое сообщение заявки в чате админа - это карточка: к ней и цепляем переписку.
const cardMessage = async (chat, requestId) =>
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

const editCard = (message, row, blocked) =>
  tg('editMessageText', {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: card(row, blocked),
    ...HTML,
    reply_markup: { inline_keyboard: cardKb(row, blocked) },
  }).catch(notModified);

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
    return send(chat, { text: 'Слишком много заявок. Попробуйте позже.' });
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

Ответ придёт сюда, в этот чат. Хотите что-то добавить - просто напишите сообщение.`,
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
    return send(msg.chat.id, { text: `Заявка #${last.id} закрыта. ${CLOSED}`, buttons: [[btn(NEW_BUTTON, 'again')]] });
  }

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
  else await send(msg.chat.id, { text: 'Не удалось передать сообщение. Попробуйте ещё раз чуть позже.' });
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
    await relay(msg, row.telegram_id, `💬 <b>Поддержка · заявка #${row.id}</b>`);
  } catch (error) {
    const why = /blocked|deactivated|chat not found/.test(error.message)
      ? 'игрок заблокировал бота или удалил аккаунт'
      : esc(error.message);
    await send(chat, { text: `Не доставлено: ${why}` }, { reply_parameters: { message_id: msg.message_id } });
    return false;
  }
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
      [mark('new'), mark('in_progress')],
      [mark('done'), mark('rejected'), mark('all')],
      ...rows.slice(0, PAGE).map((r) => [btn(
        `${STATUS[r.status]?.split(' ')[0] ?? ''} #${r.id} ${r.type === 'privilege' ? 'привилегия' : 'донат'} · ${r.steam_id} · `
          + shortDate(r.created_at),
        `rq:${r.id}`,
      )]),
      ...(nav.length ? [nav] : []),
    ],
  };
};

const setStatus = async (message, id, status) => {
  if (!['in_progress', 'done', 'rejected'].includes(status)) return 'Неизвестный статус';
  const row = await getRow(id);
  if (!row) return 'Заявка не найдена';
  if (row.status === status) return 'Статус уже такой';

  const [updated] = await sbJson(`/rest/v1/requests?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status }),
  });
  // ponytail: перерисовываем только нажатую карточку; у второго админа статус
  // на его копии останется прежним, пока он сам не откроет заявку из панели.
  await editCard(message, updated, updated.telegram_id ? await isBlocked(updated.telegram_id) : false);

  if (!updated.telegram_id) return `${STATUS[status]} · игрок с сайта, уведомления нет`;
  try {
    await send(updated.telegram_id, { text: PLAYER_STATUS[status](updated) });
    return STATUS[status];
  } catch (error) {
    console.error('status notify', error);
    return `${STATUS[status]} · игрок не получил уведомление (заблокировал бота?)`;
  }
};

const toggleBlock = async (message, id) => {
  const row = await getRow(id);
  if (!row?.telegram_id) return 'Игрока этой заявки нет в боте';
  if (isAdmin(row.telegram_id)) return 'Админа заблокировать нельзя';
  const blocked = await isBlocked(row.telegram_id);
  await (blocked
    ? sbJson(`/rest/v1/tg_blocked?telegram_id=eq.${row.telegram_id}`, { method: 'DELETE' })
    : sbJson('/rest/v1/tg_blocked', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify({ telegram_id: row.telegram_id }),
      }));
  // ponytail: как и со статусом - перерисовываем только нажатую карточку.
  await editCard(message, row, !blocked);
  return blocked ? '✅ Игрок разблокирован' : '🚫 Игрок заблокирован';
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

const runStep = async (chat, from, state, input) => {
  const r = await step(state, input, Date.now(), { steamExists });
  if (r.submit) return submit(chat, from, r.submit);
  if (state || r.state) await saveState(chat, r.state);
  for (const reply of r.replies) await send(chat, reply);
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
        : 'Здравствуйте! Это поддержка игроков GambitRP.\nКнопки внизу - подать заявку и посмотреть свои.',
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
      answer = await setStatus(cq.message, Number(a), b);
    } else if (admin && kind === 'ls') {
      await tg('editMessageText', {
        chat_id: chat,
        message_id: cq.message.message_id,
        ...HTML,
        ...(({ text, buttons }) => ({ text, reply_markup: { inline_keyboard: buttons } }))(await panel(a, Number(b) || 0)),
      }).catch(notModified);
    } else if (admin && kind === 'rq') {
      const row = await getRow(Number(a));
      if (row) await postCard(chat, row);
      else answer = 'Заявка не найдена';
    } else if (admin && kind === 'bl') {
      answer = await toggleBlock(cq.message, Number(a));
    } else if (admin && kind === 'rp') {
      answer = await startReply(chat, Number(a));
    } else if (admin && kind === 'rpx') {
      await saveState(chat, null);
      await tg('editMessageText', { chat_id: chat, message_id: cq.message.message_id, text: 'Ответ отменён.' }).catch(notModified);
    } else {
      // Кнопки анкеты одноразовые: убираем их, чтобы старую не нажали позже.
      await tg('editMessageReplyMarkup', { chat_id: chat, message_id: cq.message.message_id }).catch(() => {});
      await runStep(chat, cq.from, await loadState(chat), { data });
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
