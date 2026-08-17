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
  assert.ok(!v.steamId('7656119801234567'));
  assert.ok(!v.steamId(''));
  assert.ok(v.discord('@cheshirecat247'));
  assert.ok(v.discord('old.name#1234'));
  assert.ok(!v.discord('a'));
  assert.ok(!v.discord('ник с пробелами'));
});

test('STEAM_1 предупреждает, но не блокирует заявку', () => {
  assert.ok(v.steamId('STEAM_1:0:43836629'), 'заявка должна проходить');
  assert.deepEqual(ok('donate', { steam_id: 'STEAM_1:0:43836629' }), {}, 'ошибок быть не должно');
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

// Кадр 96xN в RGBA: pixel(x, y) возвращает [r, g, b].
const frame = (width, height, pixel) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
};

// Сцена: текстура и градиент, ровных заливок нет.
const scene = (x, y) => [(x * 7 + y * 13) % 256, 40 + (x * 31) % 200, (y * 17) % 256];

// Меню: шапка #2a2a2a, тело #1c1c1c, строки списка #232323.
const menu = (x, y) => (y < 6 ? [42, 42, 42] : (y % 7 ? [28, 28, 28] : [35, 35, 35]));

// Кадр, где меню занимает долю share по каждой стороне, а вокруг - сцена.
const shot = (share) => frame(96, 54, (x, y) => {
  const mx = Math.round(96 * (1 - share) / 2);
  const my = Math.round(54 * (1 - share) / 2);
  const inside = x >= mx && x < 96 - mx && y >= my && y < 54 - my;
  return inside ? menu(x - mx, y - my) : scene(x, y);
});

test('меню на весь кадр - обрезок', () => {
  const big = v.CROP.shareMax;
  assert.ok(v.menuShare(shot(1)) >= big, 'панель встык');
  assert.ok(v.menuShare(shot(0.9)) >= big, 'панель с ободком сцены - тоже обрезок');
  assert.ok(v.menuShare(shot(0.55)) < big, 'весь экран, меню по центру');

  // Ночная сцена без меню: тёмная и серая, но это градиент, а не заливка.
  const night = frame(96, 54, (x, y) => {
    const l = 20 + ((x * 3 + y * 5) % 60);
    return [l, l, l];
  });
  assert.ok(v.menuShare(night) < big, 'ложный отказ хуже пропуска');
});

test('вотермарка GambitRP: и жёлтая, и зелёная, но не кнопки меню', () => {
  assert.ok(v.isWatermark(124, 252, 0), 'зелёная фаза');
  assert.ok(v.isWatermark(255, 242, 0), 'жёлтая фаза');

  assert.ok(!v.isWatermark(245, 184, 32), 'жёлтая кнопка меню #f5b820');
  assert.ok(!v.isWatermark(201, 162, 60), 'золотая кнопка меню');
  assert.ok(!v.isWatermark(107, 142, 78), 'трава');
  assert.ok(!v.isWatermark(255, 255, 255), 'белый текст');
  assert.ok(!v.isWatermark(160, 200, 230), 'небо');

  // Угол кадра: строка текста вотермарки на тёмной подложке.
  const corner = frame(60, 16, (x, y) => (y === 8 && x < 40 ? [124, 252, 0] : [43, 43, 43]));
  assert.ok(v.watermarkPixels(corner) >= v.CROP.watermarkMin);
});

test('причина, по которой скриншот не похож на полный экран', () => {
  assert.equal(v.cropReason({ share: 0.2, watermark: 400 }), '', 'полный экран');
  assert.equal(v.cropReason({ share: 0.9, watermark: 0 }), 'menu', 'панель встык');
  assert.equal(v.cropReason({ share: 0.2, watermark: 0 }), 'hud', 'обрезали угол с вотермаркой');
});

test('файлы: тип и размер', () => {
  assert.ok(v.imageFile({ type: 'image/png', size: 1000 }));
  assert.ok(!v.imageFile({ type: 'application/pdf', size: 1000 }));
  assert.ok(!v.imageFile({ type: 'image/png', size: 9e6 }), 'выше лимита Vercel в 4 МБ');
  assert.ok(v.sourceFile({ type: 'image/png', size: 9e6 }), 'исходник крупнее - пережмётся');
  assert.ok(!v.sourceFile({ type: 'image/png', size: 25e6 }));
  assert.ok(!v.imageFile({ type: 'image/png', size: 0 }));
});
