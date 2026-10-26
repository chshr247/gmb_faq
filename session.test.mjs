import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, cookie } from './api/_session.js';

process.env.SESSION_SECRET = 'test-secret';

test('сессия: подпись, подделка, срок', async () => {
  const token = await sign({ id: '42', name: 'cheshirecat247', exp: Date.now() + 60e3 });
  assert.equal((await verify(token)).name, 'cheshirecat247');

  // Подменили ник в теле - подпись не сходится.
  const [, sig] = token.split('.');
  const forged = `${Buffer.from(JSON.stringify({ id: '1', name: 'admin', exp: Date.now() + 60e3 })).toString('base64url')}.${sig}`;
  assert.equal(await verify(forged), null, 'подделанное тело');

  assert.equal(await verify(token, Date.now() + 120e3), null, 'истёкшая');
  assert.equal(await verify('мусор'), null);
  assert.equal(await verify(undefined), null);

  process.env.SESSION_SECRET = 'другой';
  assert.equal(await verify(token), null, 'сменили секрет - все разлогинены');
  process.env.SESSION_SECRET = 'test-secret';
});

test('без секрета сессия не подписывается и не принимается', async () => {
  const token = await sign({ id: '42', name: 'x', exp: Date.now() + 60e3 });
  delete process.env.SESSION_SECRET;
  await assert.rejects(sign({ id: '1' }));
  assert.equal(await verify(token), null);
  process.env.SESSION_SECRET = 'test-secret';
});

test('кука читается по имени, а не по подстроке', () => {
  const request = new Request('http://x', { headers: { cookie: 'xsession=bad; session=a.b%3D' } });
  assert.equal(cookie(request, 'session'), 'a.b=');
  assert.equal(cookie(request, 'nope'), undefined);
});
