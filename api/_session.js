// Сессия после входа через Discord - подписанная кука, без базы и без
// библиотек. Файл с подчёркиванием Vercel маршрутом не считает.
//
// Токен: base64url(JSON).base64url(HMAC-SHA256). Подделать его без
// SESSION_SECRET нельзя, а сменить секрет - значит разлогинить всех.

const enc = new TextEncoder();

const toB64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// Секрет читаем при вызове, а не при загрузке модуля - так его видно тестам.
// Без секрета не подписываем ничего: пустой ключ подделал бы кто угодно.
const key = () => {
  if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET не задан');
  return crypto.subtle.importKey(
    'raw', enc.encode(process.env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
};

export const sign = async (data) => {
  const body = toB64url(enc.encode(JSON.stringify(data)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(), enc.encode(body)));
  return `${body}.${toB64url(sig)}`;
};

// null - токена нет, он подделан или истёк. subtle.verify сравнивает подпись
// за постоянное время, поэтому строки руками не сравниваем.
export const verify = async (token, now = Date.now()) => {
  try {
    const [body, sig] = String(token ?? '').split('.');
    if (!body || !sig) return null;
    if (!(await crypto.subtle.verify('HMAC', await key(), fromB64url(sig), enc.encode(body)))) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return data.exp > now ? data : null;
  } catch {
    return null;
  }
};

export const cookie = (request, name) => {
  const value = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];
  return value === undefined ? undefined : decodeURIComponent(value);
};

// httpOnly = false только у куки с ником: её читает страница, чтобы показать,
// кто вошёл. Сама сессия скрипту страницы недоступна.
export const setCookie = (name, value, maxAge, httpOnly = true) =>
  `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure`
  + (httpOnly ? '; HttpOnly' : '');
