// node --test validators.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from './validators.js';

const NOW = Date.parse('2026-08-16T12:00:00Z');

test('SteamID', () => {
  assert.ok(v.steamId('STEAM_0:1:5'));
  assert.ok(!v.steamId('7656119801234567'));
  assert.ok(!v.steamId(''));
});

test('STEAM_1 предупреждает, но не блокирует заявку', () => {
  assert.ok(v.steamId('STEAM_1:0:43836629'), 'заявка должна проходить');
  assert.match(v.steamIdNote('STEAM_1:0:43836629'), /STEAM_0/);

  assert.equal(v.steamIdNote('STEAM_0:0:43836629'), '', 'правильный ID молчит');
  assert.equal(v.steamIdNote('мусор'), '', 'на мусор отвечает ошибка формата, а не подсказка');
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
  assert.ok(!v.paidAt(null, NOW));
  assert.ok(!v.paidAt('2026-08-15T21:40', NOW), 'время больше не принимаем');
});

test('крипта и скины - к поддержке платёжки', () => {
  assert.ok(!v.acceptsForm('Криптовалюты'));
  assert.ok(!v.acceptsForm('SteamPay (Скины)'));
  assert.ok(v.acceptsForm('ЮMoney'));
});

test('SteamID64 для Steam API', () => {
  assert.equal(v.steamId64('STEAM_0:0:1'), '76561197960265730');
  assert.equal(v.steamId64('STEAM_0:1:1'), '76561197960265731', 'младший бит - это Y');
  assert.equal(v.steamId64('STEAM_0:0:43836629'), '76561198047938986');
});
