// Доступ к админ-панели: подпись Telegram Login Widget и cookie сессии.
// Сети не касается - чистые функции, их проверяет admin.test.mjs.
// Файл с подчёркиванием Vercel маршрутом не считает.

export const COOKIE = 'adm';
const SESSION_DAYS = 30;
const WIDGET_TTL = 24 * 3600e3; // данные виджета старше суток не принимаем

const enc = new TextEncoder();
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

const sha256 = (data) => crypto.subtle.digest('SHA-256', enc.encode(data));

const hmacHex = async (keyBytes, data) => {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
};

// Сравнение за постоянное время: по разнице времени отказа подпись подбирается побайтно.
const same = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// Проверка данных Telegram Login Widget (https://core.telegram.org/widgets/login).
// Возвращает { id, name } или null, если подпись не та или данные устарели.
export async function checkWidget(params, token, now = Date.now()) {
  if (!token || !params?.hash) return null;
  const data = Object.keys(params)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('\n');
  if (!same(await hmacHex(await sha256(token), data), String(params.hash))) return null;

  const authDate = Number(params.auth_date) * 1000;
  if (!authDate || now - authDate > WIDGET_TTL) return null;

  return {
    id: String(params.id),
    name: params.username ? `@${params.username}` : [params.first_name, params.last_name].filter(Boolean).join(' '),
  };
}

// Ключ сессий выводим из токена бота: своей переменной окружения не нужно,
// а смена токена сама разлогинивает всех.
const sessionKey = (token) => sha256(`admin-session:${token}`);

// Cookie вида <id>.<срок в секундах>.<подпись>. Сервер ничего не хранит.
export async function signSession(id, token, now = Date.now()) {
  const body = `${id}.${Math.floor(now / 1000) + SESSION_DAYS * 86400}`;
  return `${body}.${await hmacHex(await sessionKey(token), body)}`;
}

// id админа из cookie или null (подделана, испорчена, просрочена).
export async function readSession(value, token, now = Date.now()) {
  if (!token) return null;
  const [id, exp, sig] = String(value ?? '').split('.');
  if (!id || !exp || !sig) return null;
  if (!same(await hmacHex(await sessionKey(token), `${id}.${exp}`), sig)) return null;
  return Number(exp) * 1000 > now ? id : null;
}

export const cookieValue = (header, name = COOKIE) =>
  String(header ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

// Secure + HttpOnly: cookie не читается из JS и не уходит по http.
// SameSite=Lax заодно закрывает CSRF: со чужого сайта POST её не приложит.
export const setCookie = (value) =>
  `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;

export const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
