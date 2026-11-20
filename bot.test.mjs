// node --test bot.test.mjs - анкета бота без сети.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from './validators.js';
import { step, parseDate, card, esc } from './api/_bot.js';

const NOW = Date.parse('2026-08-16T12:00:00Z');
const deps = { steamExists: async (id) => id !== 'STEAM_0:0:1' };

// Прогоняет ввод по шагам, возвращает последний результат.
const run = async (inputs) => {
  let state = null;
  let r;
  for (const input of inputs) {
    r = await step(state, input, NOW, deps);
    state = r.state;
  }
  return r;
};

const DOC = { file: { id: 'F1', kind: 'document', mime: 'image/png' } };

test('привилегия: от /start до готового черновика', async () => {
  const r = await run([
    { text: '/start' },
    { data: 't:privilege' },
    { data: 'gate' },
    { text: ' steam_0:1:43836629 ' },
    { data: 's:0' },
    { data: 'r:1' },
    DOC,
    { text: 'спасибо' },
    { data: 'send' },
  ]);
  assert.deepEqual(r.submit, {
    type: 'privilege',
    steam_id: 'STEAM_0:1:43836629',
    server: v.SERVERS[0],
    reason: v.REASONS[1],
    file_id: 'F1',
    file_kind: 'document',
    comment: 'спасибо',
  });
});

test('донат: дата кнопкой и текстом, чек PDF, без комментария', async () => {
  const head = [{ data: 't:donate' }, { data: 'm:3' }, { text: 'STEAM_0:0:43836629' }, { data: 's:1' }, { text: '1 500' }];
  const tail = [{ file: { id: 'P', kind: 'document', mime: v.PDF } }, { data: 'skip' }, { data: 'send' }];

  const byButton = await run([...head, { data: 'd:1' }, ...tail]);
  assert.equal(byButton.submit.paid_at, '2026-08-15');
  assert.equal(byButton.submit.amount, 1500);
  assert.equal(byButton.submit.payment_method, v.PAYMENT_METHODS[3]);
  assert.equal(byButton.submit.comment, null);

  const byText = await run([...head, { text: '5.8.2026' }, ...tail]);
  assert.equal(byText.submit.paid_at, '2026-08-05');
});

test('способ оплаты с чужой поддержкой заканчивает анкету ссылкой', async () => {
  const i = v.PAYMENT_METHODS.indexOf('Криптовалюты');
  const r = await run([{ data: 't:donate' }, { data: `m:${i}` }]);
  assert.equal(r.state, null);
  assert.equal(r.replies[0].buttons[0][0].url, v.EXTERNAL_SUPPORT['Криптовалюты'].url);
});

test('неверный ввод не сдвигает шаг', async () => {
  const at = { step: 'steam', draft: { type: 'privilege' } };

  let r = await step(at, { text: '7656119801234567' }, NOW, deps);
  assert.equal(r.state, at, 'не тот формат');
  assert.match(r.replies[0].text, /Формат/);

  r = await step(at, { text: 'STEAM_0:0:1' }, NOW, deps);
  assert.equal(r.state, at, 'профиля нет в Steam');

  r = await step(at, DOC, NOW, deps);
  assert.equal(r.state, at, 'файл вместо текста');

  r = await step({ step: 'file', draft: { type: 'privilege' } }, { file: { id: 'X', kind: 'document', mime: v.PDF } }, NOW, deps);
  assert.equal(r.state.step, 'file', 'PDF у привилегии не принимаем');

  r = await step({ step: 'paid', draft: { type: 'donate' } }, { text: '01.01.2020' }, NOW, deps);
  assert.equal(r.state.step, 'paid', 'платёж старше года');
});

test('STEAM_1 предупреждает, но пропускает дальше', async () => {
  const r = await step({ step: 'steam', draft: { type: 'privilege' } }, { text: 'STEAM_1:0:5' }, NOW, deps);
  assert.equal(r.state.step, 'server');
  assert.equal(r.replies.length, 2, 'предупреждение + следующий вопрос');
});

test('сжатое фото: пометка, и файл на шаге комментария его заменяет', async () => {
  const at = { step: 'file', draft: { type: 'privilege' } };
  let r = await step(at, { file: { id: 'PH', kind: 'photo' } }, NOW, deps);
  assert.equal(r.state.draft.file_kind, 'photo');
  assert.match(r.replies[0].text, /сжал/);

  r = await step(r.state, DOC, NOW, deps);
  assert.equal(r.state.step, 'comment', 'остаёмся на комментарии');
  assert.equal(r.state.draft.file_id, 'F1');
  assert.equal(r.state.draft.file_kind, 'document');
});

test('под каждым вопросом анкеты - кнопка «Отмена», и она работает', async () => {
  let state = null;
  for (const input of [{ data: 't:donate' }, { data: 'm:3' }, { text: 'STEAM_0:0:43836629' }, { data: 's:0' }]) {
    const r = await step(state, input, NOW, deps);
    state = r.state;
    assert.equal(r.replies.at(-1).buttons.at(-1)[0].callback_data, 'cancel', `шаг ${state.step}`);
  }
  const r = await step(state, { data: 'cancel' }, NOW, deps);
  assert.equal(r.state, null);
  assert.equal(r.replies[0].buttons[0][0].callback_data, 'again', 'после отмены - «Подать заявку»');
});

test('/start и /cancel сбрасывают анкету, старая кнопка без анкеты - меню', async () => {
  const at = { step: 'amount', draft: { type: 'donate' } };
  assert.equal((await step(at, { text: '/cancel' }, NOW, deps)).state, null);
  assert.equal((await step(at, { text: '/start' }, NOW, deps)).state, null);
  const r = await step(null, { data: 's:0' }, NOW, deps);
  assert.equal(r.state, null);
  assert.equal(r.replies[0].buttons[0][0].callback_data, 't:privilege');
});

test('дата', () => {
  assert.equal(parseDate('05.08.2026'), '2026-08-05');
  assert.equal(parseDate('2026-08-05'), '2026-08-05');
  assert.equal(parseDate('5 августа'), null);
});

test('карточка экранирует ввод игрока', () => {
  const html = card({
    id: 7, type: 'privilege', status: 'new', steam_id: 'STEAM_0:0:1', server: v.SERVERS[0],
    reason: v.REASONS[0], comment: '<b>x</b> & "y"', telegram_id: 42, telegram_name: '<script>',
  });
  assert.ok(html.includes(esc('<b>x</b> & "y"')));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /#7/);
});
