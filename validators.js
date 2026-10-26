// Общие правила валидации. Используются и в браузере, и в serverless-функции -
// чтобы правила не разъехались между фронтом и бэком.

// Форму принимаем с любой первой цифрой, а правильной считаем только STEAM_0 -
// именно её показывает игра. STEAM_1 люди копируют со сторонних сайтов.
export const STEAM_ID = /^STEAM_[0-9]:[01]:\d{1,12}$/i;
export const STEAM_ID_CANON = /^STEAM_0:[01]:\d{1,12}$/i;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PDF = 'application/pdf';

// Чек банки и платёжки часто отдают готовым PDF - пересохранять его картинкой
// игрок не обязан. А лог покупок - это всегда снимок экрана игры, PDF там
// взяться неоткуда, поэтому список допустимых типов свой на каждую форму.
export const FILE_TYPES = {
  privilege: IMAGE_TYPES,
  donate: [...IMAGE_TYPES, PDF],
};

export const MIN_FILL_SECONDS = 3;

// Сколько может весить файл, который реально уходит на сервер. Потолок задан не
// нами: у edge-функции Vercel тело запроса ограничено 4 МБ (у serverless - 4.5),
// причём лишнее рвётся обрывом соединения - браузер показывает "Failed to fetch"
// вместо ошибки. 4 * 1024 * 1024 = 4.19 МБ, то есть прошлый лимит сам был выше
// потолка. Берём 3 МБ: запас и на multipart, и на обрыв мобильной загрузки.
export const MAX_FILE_BYTES = 3 * 1000 * 1000;

// Сколько разрешаем выбрать в диалоге. Всё, что тяжелее MAX_FILE_BYTES, браузер
// пережимает перед отправкой, поэтому исходник может быть крупным.
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

// По размерам кадра обрезку не ловим намеренно. Порог в пикселях отклонял
// мониторы 900px; сравнение с screen.width отклоняло GMod в окне 1280x720 на
// 2K-мониторе; соотношение сторон не отличает обрезок (747x471 - это почти
// ровно 16:10).
//
// Смотрим, какую долю кадра занимает само меню. Меню - единственная большая
// ровная заливка на скриншоте: сцена, худ и чат везде в градиентах и текстурах.
// Поэтому самый частый цвет кадра - это всегда заливка меню, а её доля прямо
// говорит, сколько вокруг меню осталось экрана:
//   панель встык        ~100%
//   панель + ободок     ~80%   <- тоже обрезок: ни худа, ни чата, ни вотермарки
//   весь экран          ~30%
// Ни разрешение, ни соотношение сторон, ни цвет меню в правило не входят.
//
// Это подсказка, а не отказ: ложный отказ хуже пропуска, поэтому заявку не
// блокируем, а показываем игроку превью и предупреждение.
// NOTE: пороги подобраны на глазок, крутить здесь - в консоли браузера на
// каждый выбранный файл печатается его menuShare.
// Второе правило - вотермарка сервера в правом верхнем углу. Она есть на любом
// полном скриншоте и первой уходит под нож при обрезке, поэтому ловит и тот
// случай, где вокруг меню оставили ободок сцены.
export const CROP = {
  tolerance: 10,    // на сколько цвет может отличаться от заливки и всё ещё считаться ею
  shareMax: 0.5,    // выше этой доли кадра - вокруг меню уже не осталось экрана
  corner: [0.3, 0.1], // правый верхний угол: доля ширины и высоты кадра
  watermarkMin: 30, // столько жёлто-зелёных пикселей в углу считаем вотермаркой
};

// data - RGBA как из canvas.getImageData. Считать нужно на уменьшенной копии:
// мелкий шум усредняется, а меню остаётся ровным пятном.
export function menuShare({ data, width, height }) {
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Самый частый цвет - заливка меню. Ключ огрублён, разворачиваем в середину
  // своей ячейки: шаг квантования 8, значит +4.
  let key = 0;
  let best = 0;
  for (const [k, n] of counts) if (n > best) { best = n; key = k; }
  const fill = [((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4];

  // Ячейка режет заливку по границе (заголовок и строки списка - соседние
  // оттенки), поэтому считаем не ячейку, а всё, что рядом с её цветом.
  let same = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - fill[0]) <= CROP.tolerance
      && Math.abs(data[i + 1] - fill[1]) <= CROP.tolerance
      && Math.abs(data[i + 2] - fill[2]) <= CROP.tolerance) same++;
  }
  return same / (width * height);
}

// Надпись GambitRP мигает между жёлтым и зелёным, поэтому ловим не оттенок, а
// класс: зелёный канал сильный, синего почти нет. Красный не выше зелёного -
// этим отсекаются жёлто-оранжевые кнопки самого меню (#f5b820 и золотая рядом),
// у них красный заметно впереди.
export const isWatermark = (r, g, b) => g >= 140 && g - b >= 90 && r <= g + 25;

// data - правый верхний угол кадра, в исходном масштабе: текст вотермарки
// тонкий и на уменьшенной копии смешивается с фоном до неузнаваемости.
export function watermarkPixels({ data }) {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (isWatermark(data[i], data[i + 1], data[i + 2])) n++;
  }
  return n;
}

// Пустая строка - похоже на полный экран. Иначе причина, по которой не похож.
export const cropReason = ({ share, watermark }) =>
  share >= CROP.shareMax ? 'menu'
    : watermark < CROP.watermarkMin ? 'hud'
      : '';

export const SERVERS = [
  '1 сервер (rp_bangclaw)',
  '2 сервер (rp_downtown_tits_v2)',
];

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

// Не ошибка, а подсказка: заявку пропускаем, но говорим, что цифра не та.
export const steamIdNote = (v) => {
  const s = String(v ?? '').trim();
  return STEAM_ID.test(s) && !STEAM_ID_CANON.test(s)
    ? 'Все SteamID на сервере начинаются с STEAM_0. Проверьте первую цифру - похоже, ID скопирован со стороннего сайта и при разбане табличный бан снимается вручную, а обычный выдаётся заново после разбана, компенсируя табличку. Заполняйте дальше, заявку это не блокирует.'
    : '';
};
// STEAM_0:Y:Z -> SteamID64 для Steam API: база аккаунтов + Z*2 + Y.
export const steamId64 = (id) => {
  const [, y, z] = String(id).split(':');
  return (76561197960265728n + BigInt(z) * 2n + BigInt(y)).toString();
};

export const reason = (v) => REASONS.includes(v);
export const server = (v) => SERVERS.includes(v);
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

// kind - тип заявки: от него зависит, принимаем ли PDF. Без него - только картинки.
const typeAllowed = (type, kind) => (FILE_TYPES[kind] ?? IMAGE_TYPES).includes(type);

// Проверка того, что уходит на сервер (и того, что сервер принимает).
export const attachment = ({ type, size }, kind) =>
  typeAllowed(type, kind) && size > 0 && size <= MAX_FILE_BYTES;

// Проверка выбранного файла до сжатия. Картинку браузер пережмёт, PDF - нет,
// поэтому у PDF потолок сразу серверный.
export const sourceFile = ({ type, size }, kind) =>
  typeAllowed(type, kind) && size > 0
  && size <= (type === PDF ? MAX_FILE_BYTES : MAX_SOURCE_BYTES);

// Одно сообщение на фронт и на сервер, чтобы лимиты в текстах не разъезжались.
export const fileError = (kind) =>
  kind === 'donate'
    ? 'Чек: JPG, PNG или WEBP до 20 МБ, либо PDF до 3 МБ'
    : 'Только JPG, PNG или WEBP размером до 20 МБ';

// Проверяет заявку целиком. Возвращает объект ошибок: {} - заявка валидна.
export function validate(type, d, now = Date.now()) {
  const e = {};
  if (!steamId(d.steam_id)) e.steam_id = 'Формат: STEAM_0:0:43836629';
  if (!server(d.server)) e.server = 'Выберите сервер из списка';

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
