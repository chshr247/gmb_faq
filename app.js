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

// Подсказка, а не ошибка: поле не подсвечивается, отправку не блокирует.
const setNote = (field, message) => {
  const slot = $('.warn', field);
  if (slot) slot.textContent = message ?? '';
};

for (const input of document.querySelectorAll('input[name="steam_id"]')) {
  input.addEventListener('input', () => {
    setNote(input.closest('.field'), v.steamIdNote(input.value));
  });
}

// ── Проверка картинки: тип и размер ───────────────────────────────────
const checkImage = (input) => {
  const file = input.files[0];
  if (!file) return input.required ? input.dataset.missing ?? 'Прикрепите скриншот' : '';
  return v.sourceFile(file) ? '' : 'Только JPG, PNG или WEBP размером до 20 МБ';
};

// Скриншоты в PNG легко весят больше, чем принимает сервер (4 МБ), поэтому
// крупные пережимаем прямо в браузере. Мелкие не трогаем: PNG чётче для текста.
const MAX_SIDE = 1920;

const compress = async (file) => {
  if (file.size <= v.MAX_FILE_BYTES) return file;

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
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

// ── Подсказка про обрезанный скриншот ─────────────────────────────────
// Правила считает validators, отсюда только пиксели. 96px по ширине хватает:
// мелкий шум усредняется, ровная заливка меню остаётся.
const SAMPLE_WIDTH = 96;

const CROP_NOTE = {
  menu: 'Похоже, скриншот обрезан: меню занимает почти весь кадр, а игры вокруг него нет. '
    + 'Нужен снимок всего экрана целиком - с худом и чатом, иначе заявку вернут на доработку.',
  hud: 'Похоже, скриншот обрезан: в правом верхнем углу не видно надписи GambitRP. '
    + 'Нужен снимок всего экрана целиком, от угла до угла, иначе заявку вернут на доработку.',
};

const measure = async (file) => {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Весь кадр уменьшенным - для доли, которую занимает меню.
  const width = SAMPLE_WIDTH;
  const height = Math.max(1, Math.round(width * bitmap.height / bitmap.width));
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(bitmap, 0, 0, width, height);
  const share = v.menuShare(ctx.getImageData(0, 0, width, height));

  // Правый верхний угол - в исходном масштабе, иначе тонкий текст вотермарки
  // размажется по фону.
  const [cw, ch] = v.CROP.corner.map((part, i) =>
    Math.max(1, Math.round((i ? bitmap.height : bitmap.width) * part)));
  canvas.width = cw;
  canvas.height = ch;
  ctx.drawImage(bitmap, bitmap.width - cw, 0, cw, ch, 0, 0, cw, ch);
  const watermark = v.watermarkPixels(ctx.getImageData(0, 0, cw, ch));

  bitmap.close();
  return { share, watermark };
};

for (const input of document.querySelectorAll('input[type="file"]')) {
  input.addEventListener('change', async () => {
    const field = input.closest('.field');
    const message = checkImage(input);
    setError(field, message);
    showPreview(input, message);
    setNote(field, '');

    // Чек из банка - законно обрезанный скриншот, его не проверяем.
    const file = input.files[0];
    if (message || !file || !('fullscreen' in input.dataset)) return;
    try {
      const stats = await measure(file);
      console.debug('screenshot', file.name, stats); // пороги крутятся в validators.js CROP
      // Пока считали, игрок мог выбрать другой файл.
      if (input.files[0] === file) setNote(field, CROP_NOTE[v.cropReason(stats)] ?? '');
    } catch {
      // Битый или экзотический файл: это подсказка, а не проверка - молчим.
    }
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
    setNote(fieldOf(form, 'steam_id'), v.steamIdNote(data.steam_id));

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
      if (shot.files[0]) {
        const prepared = await compress(shot.files[0]);
        if (!v.imageFile(prepared)) {
          throw new Error('Скриншот слишком большой даже после сжатия. Сохраните его в JPG и попробуйте снова');
        }
        payload.set('screenshot', prepared, prepared.name);
      }

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

// ── Вспышка за курсором ───────────────────────────────────────────────
// Рисует её .cursor-glow, отсюда только координаты. Тач-устройства мимо.
if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
  addEventListener('pointermove', (e) => {
    document.documentElement.style.setProperty('--mx', `${e.clientX}px`);
    document.documentElement.style.setProperty('--my', `${e.clientY}px`);
  }, { passive: true });
}

// ── Свой список вместо нативного попапа ───────────────────────────────
// Попап <select> рисует ОС - наш курсор туда не долетает и подменяется
// системной стрелкой. Подменяем только попап: сам <select> остаётся на месте,
// значение, валидацию, ошибки и клавиатуру по-прежнему ведёт он.
// На тач-экранах курсора нет, а системный барабан удобнее - там не трогаем.
if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.hidden = true;
  menu.setAttribute('aria-hidden', 'true'); // озвучивает по-прежнему сам select
  document.body.append(menu);

  let owner = null;
  let items = [];
  let active = -1; // подсвеченный пункт: с клавиатуры он же и выбирается

  const close = () => { menu.hidden = true; owner = null; items = []; };

  const highlight = (index) => {
    items[active]?.classList.remove('on');
    active = index;
    items[active]?.classList.add('on');
    items[active]?.scrollIntoView({ block: 'nearest' });
  };

  const pick = (index) => {
    const select = owner;
    close();
    if (!select || index < 0 || select.selectedIndex === index) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const open = (select) => {
    owner = select;
    active = -1;
    items = [...select.options].map((option, index) => {
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.textContent = option.text;
      item.addEventListener('click', () => pick(index));
      return item;
    });
    menu.replaceChildren(...items);

    const box = select.getBoundingClientRect();
    menu.style.left = `${box.left}px`;
    menu.style.width = `${box.width}px`;
    menu.style.top = '0';
    menu.hidden = false;

    // Высоту знаем только после показа - и лишь тогда видно, влезает ли список
    // под полем или его надо откинуть вверх.
    const below = box.bottom + 6;
    menu.style.top = below + menu.offsetHeight <= innerHeight
      ? `${below}px`
      : `${Math.max(6, box.top - 6 - menu.offsetHeight)}px`;

    highlight(select.selectedIndex);
  };

  addEventListener('mousedown', (e) => {
    if (menu.contains(e.target)) return; // выбор доедет своим click
    const select = e.target.closest('select');
    const previous = owner;
    close();
    if (!select) return;
    e.preventDefault(); // нативный попап не открывается
    select.focus();
    if (select !== previous) open(select); // повторный клик по полю закрывает
  });

  // Space и F4 (в Windows) тоже зовут нативный попап - перехватываем и их,
  // иначе список открывался бы то наш, то системный.
  const OPENS = new Set([' ', 'F4', 'Enter']);

  addEventListener('keydown', (e) => {
    if (!owner) {
      const select = e.target.closest?.('select');
      if (!select || !(OPENS.has(e.key) || (e.altKey && e.key.startsWith('Arrow')))) return;
      e.preventDefault();
      open(select);
      return;
    }

    switch (e.key) {
      case 'Escape': case 'Tab': close(); return; // Tab уводит с поля как обычно
      case 'Enter': case ' ': pick(active); break;
      case 'ArrowDown': highlight(Math.min(active + 1, items.length - 1)); break;
      case 'ArrowUp': highlight(Math.max(active - 1, 0)); break;
      case 'Home': highlight(0); break;
      case 'End': highlight(items.length - 1); break;
      default: return;
    }
    e.preventDefault();
  });

  // Прокрутку внутри самого меню закрытием считать нельзя - это листание списка.
  addEventListener('scroll', (e) => { if (!menu.contains(e.target)) close(); }, true);
  addEventListener('resize', close);
}
