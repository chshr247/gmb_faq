// Правила заявки: списки вариантов и проверки ответов анкеты бота (api/_bot.js).

// Форму принимаем с любой первой цифрой, а правильной считаем только STEAM_0 -
// именно её показывает игра. STEAM_1 люди копируют со сторонних сайтов.
export const STEAM_ID = /^STEAM_[0-9]:[01]:\d{1,12}$/i;
export const STEAM_ID_CANON = /^STEAM_0:[01]:\d{1,12}$/i;

// Чек банки и платёжки часто отдают готовым PDF. Лог покупок - это всегда
// снимок экрана игры, поэтому PDF принимаем только у доната.
export const PDF = 'application/pdf';

export const SERVERS = [
  '1 сервер (rp_bangclaw)',
  '2 сервер (rp_downtown_tits_v2)',
];

export const REASONS = [
  'После наборки',
  'Автоснятие за спам ULX-командами',
  'Забыли снять варны с прошлой админки',
];

// Как в окне «Покупка кредитов» на сайте доната - игрок выбирает то, что видел там.
export const PAYMENT_METHODS = [
  'Криптовалюты',
  'ЮMoney',
  '#2 СБП (от 100 руб)',
  '#3 СБП (от 10 руб)',
  '#4 СБП (от 10 руб)',
  '#5 Карты РФ (от 10 руб)',
  'Зарубежные карты (от 150 руб)',
  'Украинские карты (от 250 руб)',
  'SteamPay (Скины)',
];

// Способы оплаты, по которым заявку принимаем не мы, а поддержка платёжной системы.
export const EXTERNAL_SUPPORT = {
  'Криптовалюты': { name: 'AnyPay', url: 'https://anypay.io/support' },
  'SteamPay (Скины)': { name: 'SkinsBack', url: 'https://t.me/skinsbackcom_bot' },
};

export const steamId = (v) => STEAM_ID.test(String(v ?? '').trim());

// Не ошибка, а подсказка: заявку пропускаем, но говорим, что цифра не та.
export const steamIdNote = (v) => {
  const s = String(v ?? '').trim();
  return STEAM_ID.test(s) && !STEAM_ID_CANON.test(s)
    ? 'SteamID на сервере всегда начинается с STEAM_0, а у вас другая цифра. Скорее всего, ID скопирован со стороннего сайта. Заявку это не остановит, можно продолжать.'
    : '';
};

// STEAM_0:Y:Z -> SteamID64 для Steam API: база аккаунтов + Z*2 + Y.
export const steamId64 = (id) => {
  const [, y, z] = String(id).split(':');
  return (76561197960265728n + BigInt(z) * 2n + BigInt(y)).toString();
};

export const acceptsForm = (method) => !(method in EXTERNAL_SUPPORT);

export const amount = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 1_000_000;
};

// Дата в формате YYYY-MM-DD. now передаётся явно, чтобы поведение не зависело
// от часов машины при проверке.
export const paidAt = (v, now = Date.now()) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''))) return false;
  const t = Date.parse(`${v}T00:00:00+03:00`); // дата означает московский день
  if (Number.isNaN(t)) return false;
  const YEAR = 365 * 24 * 3600 * 1000;
  return t <= now + 24 * 3600 * 1000 && t > now - YEAR; // сутки запаса на часовые пояса
};
