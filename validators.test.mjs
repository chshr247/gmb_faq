// node --test validators.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from './validators.js';

const NOW = Date.parse('2026-08-16T12:00:00Z');
const ok = (type, extra) =>
  v.validate(type, {
    steam_id: 'STEAM_0:0:43836629',
    discord: 'cheshirecat247',
    reason: v.REASONS[0],
    amount: '300',
    payment_method: '#3 Карты РФ/СБП (от 300 руб)',
    paid_at: '2026-08-15',
    ...extra,
  }, NOW);

test('корректные заявки проходят', () => {
  assert.deepEqual(ok('privilege'), {});
  assert.deepEqual(ok('donate'), {});
});

test('SteamID и Discord', () => {
  assert.ok(v.steamId('STEAM_0:1:5'));
  assert.ok(!v.steamId('STEAM_1:0:5'));
  assert.ok(!v.steamId('7656119801234567'));
  assert.ok(!v.steamId(''));
  assert.ok(v.discord('@cheshirecat247'));
  assert.ok(v.discord('old.name#1234'));
  assert.ok(!v.discord('a'));
  assert.ok(!v.discord('ник с пробелами'));
});

test('сумма кредитов - целое положительное', () => {
  assert.ok(v.amount('300'));
  assert.ok(!v.amount('0'));
  assert.ok(!v.amount('-5'));
  assert.ok(!v.amount('30.5'));
  assert.ok(!v.amount('много'));
});

test('дата платежа: не из будущего и не старше года', () => {
  assert.ok(v.paidAt('2026-08-15', NOW));
  assert.ok(v.paidAt('2026-08-16', NOW), 'сегодняшняя дата должна проходить');
  assert.ok(!v.paidAt('2027-01-01', NOW));
  assert.ok(!v.paidAt('2024-01-01', NOW));
  assert.ok(!v.paidAt('не дата', NOW));
  assert.ok(!v.paidAt('2026-08-15T21:40', NOW), 'время больше не принимаем');
});

test('крипта и скины на форму не проходят - их ведёт поддержка платёжки', () => {
  assert.ok(!v.acceptsForm('Криптовалюты'));
  assert.ok(!v.acceptsForm('SteamPay (Скины)'));
  assert.ok(v.acceptsForm('ЮMoney'));
  assert.ok(ok('donate', { payment_method: 'Криптовалюты' }).payment_method);
});

test('чужие значения в списках не принимаются', () => {
  assert.ok(ok('privilege', { reason: 'просто так' }).reason);
  assert.ok(ok('donate', { payment_method: 'Наличными' }).payment_method);
  assert.ok(v.validate('что-то', {}, NOW).type);
});

test('файлы: тип и размер', () => {
  assert.ok(v.imageFile({ type: 'image/png', size: 1000 }));
  assert.ok(!v.imageFile({ type: 'application/pdf', size: 1000 }));
  assert.ok(!v.imageFile({ type: 'image/png', size: 9e6 }));
  assert.ok(!v.imageFile({ type: 'image/png', size: 0 }));
});
