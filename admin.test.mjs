// node --test admin.test.mjs - вход в админ-панель: подпись виджета и cookie.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { checkWidget, signSession, readSession, cookieValue, setCookie } from './api/_auth.js';

const TOKEN = '123456:TEST-TOKEN';
const NOW = Date.parse('2026-08-16T12:00:00Z');

// Подписываем так, как это делает Telegram: ключ - SHA256 токена бота.
const sign = (params) => {
  const data = Object.keys(params).filter((k) => k !== 'hash').sort().map((k) => `${k}=${params[k]}`).join('\n');
  return createHmac('sha256', createHash('sha256').update(TOKEN).digest()).update(data).digest('hex');
};

const widget = (extra = {}) => {
  const params = { id: '777', first_name: 'Слава', username: 'cheshire', auth_date: String(NOW / 1000), ...extra };
  return { ...params, hash: sign(params) };
};

test('виджет: верная подпись принимается', async () => {
  assert.deepEqual(await checkWidget(widget(), TOKEN, NOW), { id: '777', name: '@cheshire' });
});

test('виджет: без username имя собирается из имени и фамилии', async () => {
  const params = widget({ username: undefined, last_name: 'М.' });
  delete params.username;
  params.hash = sign(params);
  assert.equal((await checkWidget(params, TOKEN, NOW)).name, 'Слава М.');
});

test('виджет: подделанное поле не проходит', async () => {
  assert.equal(await checkWidget({ ...widget(), id: '1' }, TOKEN, NOW), null);
});

test('виджет: чужой токен не проходит', async () => {
  assert.equal(await checkWidget(widget(), 'другой', NOW), null);
});

test('виджет: данные старше суток не проходят', async () => {
  assert.equal(await checkWidget(widget(), TOKEN, NOW + 25 * 3600e3), null);
});

test('виджет: без hash и без токена - null', async () => {
  assert.equal(await checkWidget({ id: '777' }, TOKEN, NOW), null);
  assert.equal(await checkWidget(widget(), '', NOW), null);
});

test('cookie: своя подпись читается, чужая - нет', async () => {
  const value = await signSession('777', TOKEN, NOW);
  assert.equal(await readSession(value, TOKEN, NOW), '777');
  assert.equal(await readSession(value, 'другой', NOW), null);
  assert.equal(await readSession(value.replace(/^777/, '778'), TOKEN, NOW), null);
  assert.equal(await readSession('мусор', TOKEN, NOW), null);
  assert.equal(await readSession(undefined, TOKEN, NOW), null);
});

test('cookie: через 31 день просрочена', async () => {
  const value = await signSession('777', TOKEN, NOW);
  assert.equal(await readSession(value, TOKEN, NOW + 29 * 86400e3), '777');
  assert.equal(await readSession(value, TOKEN, NOW + 31 * 86400e3), null);
});

test('cookie: разбор заголовка и флаги', async () => {
  assert.equal(cookieValue('a=1; adm=777.1.ab; b=2'), '777.1.ab');
  assert.equal(cookieValue('other=1'), undefined);
  const header = setCookie('777.1.ab');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.match(header, new RegExp(flag));
});
