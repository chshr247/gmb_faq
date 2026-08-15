// Общие правила валидации. Используются и в браузере, и в serverless-функции -
// чтобы правила не разъехались между фронтом и бэком.

export const STEAM_ID = /^STEAM_0:[01]:\d{1,12}$/i;
export const DISCORD = /^@?[a-zA-Z0-9._]{2,32}(#\d{4})?$/;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MIN_FILL_SECONDS = 3;

// Автоматической проверки на обрезанный скриншот здесь нет намеренно.
// Порог в пикселях отклонял мониторы 900px; сравнение с screen.width отклоняло
// GMod в окне 1280x720 на 2K-мониторе; соотношение сторон не отличает обрезок
// (747x471 - это почти ровно 16:10). Ложный отказ хуже пропуска: честный игрок
// всё равно придёт в Discord, а ради этого всё и затевалось.
// Вместо угадывания игроку показывается превью того, что он прикрепил.

export const REASONS = [
  'После наборки',
  'Автоснятие за спам ULX-командами',
  'Забыли снять варны с прошлой админки',
];

export const PAYMENT_METHODS = [
  'Криптовалюты',
  'Мобильные платежи',
  'ЮMoney',
  '#1 Карты РФ/СБП',
  '#2 СБП (от 100 руб)',
  '#3 Карты РФ/СБП (от 300 руб)',
  '#4 Карты РФ/СБП (от 300 руб)',
  'Украинские карты (от 250 руб)',
  'SteamPay (Скины)',
];

// Способы оплаты, по которым заявку принимаем не мы, а поддержка платёжной системы.
export const EXTERNAL_SUPPORT = {
  'Криптовалюты': { name: 'AnyPay', url: 'https://anypay.io/support' },
  'SteamPay (Скины)': { name: 'SkinsBack', url: 'https://t.me/skinsbackcom_bot' },
};

export const steamId = (v) => STEAM_ID.test(String(v ?? '').trim());
export const discord = (v) => DISCORD.test(String(v ?? '').trim());
export const reason = (v) => REASONS.includes(v);
export const paymentMethod = (v) => PAYMENT_METHODS.includes(v);
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

export const imageFile = ({ type, size }) =>
  IMAGE_TYPES.includes(type) && size > 0 && size <= MAX_FILE_BYTES;

// Проверяет заявку целиком. Возвращает объект ошибок: {} - заявка валидна.
export function validate(type, d, now = Date.now()) {
  const e = {};
  if (!steamId(d.steam_id)) e.steam_id = 'Формат: STEAM_0:0:43836629';
  if (!discord(d.discord)) e.discord = 'Укажите ваш Discord (например: cheshirecat247)';

  if (type === 'privilege') {
    if (!reason(d.reason)) e.reason = 'Выберите причину';
  } else if (type === 'donate') {
    if (!amount(d.amount)) e.amount = 'Целое число кредитов больше нуля';
    if (!paymentMethod(d.payment_method)) e.payment_method = 'Выберите способ оплаты';
    else if (!acceptsForm(d.payment_method)) e.payment_method = 'По этому способу оплаты обратитесь в поддержку платёжной системы';
    if (!paidAt(d.paid_at, now)) e.paid_at = 'Укажите дату платежа';
  } else {
    e.type = 'Неизвестный тип заявки';
  }
  return e;
}
