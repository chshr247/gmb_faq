import { sign, cookie, setCookie } from './_session.js';

// Вход через Discord (OAuth2, scope identify). Один адрес на все шаги:
//   /api/discord           - уводит на страницу входа Discord
//   /api/discord?code=...  - Discord вернул игрока обратно, заводим сессию
//   /api/discord?logout    - выходим
// Адрес возврата тот же, его и нужно прописать в Discord Developer Portal.
export const config = { runtime: 'edge' };

const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET } = process.env;

const SESSION_SECONDS = 30 * 24 * 3600;
const STATE_SECONDS = 10 * 60;

const redirect = (to, cookies = []) => {
  const headers = new Headers({ location: String(to) });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
};

const failed = () => redirect('/?login=failed', [setCookie('oauth_state', '', 0)]);

export default async function handler(request) {
  const url = new URL(request.url);
  const back = `${url.origin}/api/discord`;

  if (url.searchParams.has('logout')) {
    return redirect('/', [setCookie('session', '', 0), setCookie('discord_name', '', 0, false)]);
  }

  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !SESSION_SECRET) {
    console.error('Не заданы переменные Discord - см. .env.example');
    return new Response('Вход временно не работает. Напишите в Discord: cheshirecat247', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // Игрок нажал «Отмена» на странице Discord. Без этой проверки его тут же
  // отправило бы на вход снова - по кругу.
  if (url.searchParams.has('error')) return failed();

  const code = url.searchParams.get('code');
  if (!code) {
    // state - защита от подсунутого входа: обратно примем только тот
    // ответ Discord, который начался в этом же браузере.
    const state = crypto.randomUUID();
    const auth = new URL('https://discord.com/oauth2/authorize');
    auth.search = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: back,
      response_type: 'code',
      scope: 'identify',
      state,
      prompt: 'none', // кто уже разрешал доступ, не увидит экран согласия повторно
    });
    return redirect(auth, [setCookie('oauth_state', state, STATE_SECONDS)]);
  }

  if (!url.searchParams.get('state') || url.searchParams.get('state') !== cookie(request, 'oauth_state')) {
    return failed();
  }

  try {
    const token = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: back,
      }),
    });
    if (!token.ok) throw new Error(`token ${token.status}: ${await token.text()}`);
    const { access_token } = await token.json();

    const me = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!me.ok) throw new Error(`users/@me ${me.status}: ${await me.text()}`);
    const { id, username } = await me.json();

    const session = await sign({ id, name: username, exp: Date.now() + SESSION_SECONDS * 1000 });
    return redirect('/', [
      setCookie('session', session, SESSION_SECONDS),
      setCookie('discord_name', username, SESSION_SECONDS, false),
      setCookie('oauth_state', '', 0),
    ]);
  } catch (error) {
    console.error('discord', error);
    return failed();
  }
}
