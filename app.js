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
  scrollTo({ top: 0, behavior: 'smooth' });
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

// ── Проверка картинки: тип, размер и — для лога покупок — ширина ───────
const checkImage = async (input) => {
  const file = input.files[0];
  if (!file) return input.required ? 'Прикрепите скриншот' : '';
  if (!v.imageFile(file)) return 'Только JPG, PNG или WEBP размером до 5 МБ';
  if (!input.hasAttribute('data-min-width')) return '';

  const url = URL.createObjectURL(file);
  try {
    const { width } = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth });
      img.onerror = () => reject(new Error('broken'));
      img.src = url;
    });
    return width < v.MIN_SCREENSHOT_WIDTH
      ? 'Похоже, скриншот обрезан. Нужен снимок всего экрана целиком'
      : '';
  } catch {
    return 'Не удалось прочитать файл — попробуйте другой скриншот';
  } finally {
    URL.revokeObjectURL(url);
  }
};

for (const input of document.querySelectorAll('input[type="file"]')) {
  input.addEventListener('change', async () => {
    setError(input.closest('.field'), await checkImage(input));
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
    if (type === 'privilege' || shot.files.length) {
      const message = await checkImage(shot);
      if (message) errors.screenshot = message;
    }

    for (const field of form.querySelectorAll('.field')) setError(field, '');
    for (const [name, message] of Object.entries(errors)) setError(fieldOf(form, name), message);

    const first = $('.invalid', form);
    if (first) {
      first.focus();
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
      scrollTo({ top: 0, behavior: 'smooth' });
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
