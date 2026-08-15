import * as v from './validators.js';

const $ = (sel, root = document) => root.querySelector(sel);

const DONE_TEXT = {
  privilege: 'Привилегия будет выдана в течение дня.',
  donate: 'Проверка занимает от 1 до 3 дней. По истечении проверки с большой вероятностью вы увидите кредиты у себя на балансе.',
};

const sections = {
  privilege: $('#s-privilege'),
  donate: $('#s-donate'),
};
const done = $('#s-done');

let openedAt = Date.now();

// Системная настройка «меньше движения» распространяется и на программную прокрутку.
const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

// ── Ник в подвале копируется кликом ───────────────────────────────────
const DISCORD = 'cheshirecat247';
const copyButton = $('#copy-discord');
copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(DISCORD);
    copyButton.textContent = 'Ник скопирован';
    setTimeout(() => { copyButton.textContent = 'Discord'; }, 1600);
  } catch {
    // Буфер недоступен (нет https или отказ в доступе) - ник продублирован в подвале.
  }
});

// ── Дата платежа: не позже сегодняшнего дня по Москве ─────────────────
// en-CA даёт ровно тот формат ГГГГ-ММ-ДД, который ждёт input[type=date].
$('#d-paid').max = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' })
  .format(new Date());

// ── Заполняем списки из общих правил, чтобы варианты не разъезжались ──
const fill = (select, items) => {
  for (const item of items) select.add(new Option(item, item));
};
fill($('#p-reason'), v.REASONS);
fill($('#d-method'), v.PAYMENT_METHODS);

// ── Переключение экранов ──────────────────────────────────────────────
$('#problem').addEventListener('change', (e) => {
  done.hidden = true;
  for (const [type, section] of Object.entries(sections)) {
    section.hidden = type !== e.target.value;
  }
  openedAt = Date.now();
});

$('#again').addEventListener('click', () => {
  $('#problem').value = '';
  done.hidden = true;
  for (const section of Object.values(sections)) section.hidden = true;
  // Возвращаем допуск в исходное - иначе следующая заявка откроется с уже
  // проставленной галочкой «условия прочитал».
  $('#gate-privilege').checked = false;
  $('.form', sections.privilege).hidden = true;
  scrollTo({ top: 0, behavior });
});

// ── Допуск к форме возврата привилегии ────────────────────────────────
$('#gate-privilege').addEventListener('change', (e) => {
  $('.form', sections.privilege).hidden = !e.target.checked;
  openedAt = Date.now();
});

// ── Способы оплаты, по которым мы заявку не принимаем ─────────────────
const externalNote = $('#external-support');
const externalLink = $('#external-link');

$('#d-method').addEventListener('change', (e) => {
  const external = v.EXTERNAL_SUPPORT[e.target.value];
  externalNote.hidden = !external;
  $('.rest', sections.donate).hidden = Boolean(external);
  if (external) {
    externalLink.textContent = `Поддержка ${external.name} → ${external.url}`;
    externalLink.href = external.url;
  }
});

// ── Ошибки полей ──────────────────────────────────────────────────────
const setError = (field, message) => {
  const slot = $('.err', field); // у необязательных полей его нет
  if (slot) slot.textContent = message ?? '';
  $('input, select, textarea', field).classList.toggle('invalid', Boolean(message));
};

const fieldOf = (form, name) => $(`[name="${name}"]`, form).closest('.field');

// ── Проверка картинки: тип и размер ───────────────────────────────────
const checkImage = (input) => {
  const file = input.files[0];
  if (!file) return input.required ? input.dataset.missing ?? 'Прикрепите скриншот' : '';
  return v.imageFile(file) ? '' : 'Только JPG, PNG или WEBP размером до 5 МБ';
};

// Превью вместо автоматической проверки на обрезку: игрок видит, что именно
// уходит, и сам ловит обрезанный кадр. Ни одного ложного отказа.
const showPreview = (input, message) => {
  const preview = $('.preview', input.closest('.field'));
  if (!preview) return;

  const img = $('img', preview);
  URL.revokeObjectURL(img.src);

  const file = input.files[0];
  if (!file || message) {
    img.removeAttribute('src');
    preview.hidden = true;
    return;
  }
  img.src = URL.createObjectURL(file);
  preview.hidden = false;
};

for (const input of document.querySelectorAll('input[type="file"]')) {
  input.addEventListener('change', () => {
    const message = checkImage(input);
    setError(input.closest('.field'), message);
    showPreview(input, message);
  });
}

// ── Отправка ──────────────────────────────────────────────────────────
for (const form of document.querySelectorAll('.form')) {
  const type = form.dataset.type;
  const button = $('button[type="submit"]', form);
  const formError = $('.form-err', form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    formError.textContent = '';

    const data = Object.fromEntries(new FormData(form));
    const errors = v.validate(type, data);

    const shot = $('input[type="file"]', form);
    const shotError = checkImage(shot);
    if (shotError) errors.screenshot = shotError;

    for (const field of form.querySelectorAll('.field')) setError(field, '');
    for (const [name, message] of Object.entries(errors)) setError(fieldOf(form, name), message);

    const first = $('.invalid', form);
    if (first) {
      first.focus();
      first.scrollIntoView({ block: 'center', behavior });
      return;
    }

    const payload = new FormData(form);
    payload.set('type', type);
    payload.set('elapsed', String(Math.round((Date.now() - openedAt) / 1000)));

    button.disabled = true;
    button.textContent = 'Отправляем…';
    try {
      const response = await fetch('/api/submit', { method: 'POST', body: payload });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        for (const [name, message] of Object.entries(body.errors ?? {})) {
          setError(fieldOf(form, name), message);
        }
        throw new Error(body.error ?? (body.errors ? 'Проверьте выделенные поля' : ''));
      }

      form.reset();
      sections[type].hidden = true;
      $('#done-text').textContent = DONE_TEXT[type];
      done.hidden = false;
      scrollTo({ top: 0, behavior });
    } catch (error) {
      formError.textContent =
        error.message ||
        'Не удалось отправить заявку. Попробуйте ещё раз или напишите в Discord: cheshirecat247';
    } finally {
      button.disabled = false;
      button.textContent = 'Отправить заявку';
    }
  });
}
