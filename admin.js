// Панель заявок: список, заявка, переписка, статусы, заметки, шаблоны.
// Сервер - api/admin.js. Без сборки и фреймворка, как весь остальной сайт.

const BOT = 'gmbt_support_bot';
const POLL = 8000;

const STATUS = { new: '🆕 Новая', in_progress: '🔄 На рассмотрении', done: '✅ Выдано', rejected: '❌ Отказано' };
const SET_STATUS = { in_progress: '🔄 На рассмотрении', done: '✅ Выдано', rejected: '❌ Отказано' };
const FILTERS = { all: 'Все', new: '🆕 Новые', in_progress: '🔄 В работе', done: '✅ Выданы', rejected: '❌ Отказаны' };
const SORTS = { new: 'Сначала новые', old: 'Сначала старые', wait: 'Ждут ответа' };
const TYPE = { privilege: 'привилегия', donate: 'донат' };

const $ = (id) => document.getElementById(id);

const esc = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const state = {
  filter: 'all', sort: 'new', q: '', offset: 0,
  rows: [], id: null, data: null, lastMsg: 0, templates: [],
};

// ── Сервер ───────────────────────────────────────────────────────────

const api = async (action, { method = 'GET', body, params } = {}) => {
  const url = new URL('/api/admin', location.origin);
  url.searchParams.set('a', action);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    ...(body && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (response.status === 401) {
    showGate();
    throw new Error('auth');
  }
  return response.json();
};

// ── Формат ───────────────────────────────────────────────────────────

const msk = (t, options) => new Date(t).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', ...options });
const shortDate = (t) => msk(t, { day: '2-digit', month: '2-digit' });
const dateTime = (t) => msk(t, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fullDate = (t) => msk(t, { day: '2-digit', month: '2-digit', year: 'numeric' });

const fileUrl = (id) => `/api/admin?a=file&id=${encodeURIComponent(id)}`;

// Игрок написал после того, как заявку последний раз открывали.
const unread = (r) =>
  Boolean(r.last_player_at) && (!r.last_seen_at || Date.parse(r.last_player_at) > Date.parse(r.last_seen_at));

// ── Вход ─────────────────────────────────────────────────────────────

let polling;

function showGate(message) {
  clearInterval(polling);
  $('app').hidden = true;
  $('login').hidden = false;
  if (message) $('gate-hint').textContent = message;
  if ($('tg-button').childElementCount) return;

  // Скрипт виджета грузим только здесь: авторизованному он не нужен.
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://telegram.org/js/telegram-widget.js?22';
  script.dataset.telegramLogin = BOT;
  script.dataset.size = 'large';
  script.dataset.authUrl = `${location.origin}/api/admin?a=login`;
  script.dataset.requestAccess = 'write';
  script.onerror = () => {
    $('gate-hint').textContent = 'Кнопка Telegram не загрузилась: telegram.org не открывается. '
      + 'Скажи об этом - сделаем вход по одноразовой ссылке из бота.';
  };
  $('tg-button').append(script);
}

// ── Список ───────────────────────────────────────────────────────────

const chips = (node, options, current, onPick) => {
  node.innerHTML = '';
  for (const [key, label] of Object.entries(options)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(key === current));
    chip.onclick = () => onPick(key);
    node.append(chip);
  }
};

const rowHtml = (r) => `
  <button type="button" class="row" data-id="${r.id}" aria-current="${r.id === state.id}">
    <span class="row-top">
      <span class="row-id">#${r.id}</span>
      <span class="tag ${r.status}">${esc(STATUS[r.status] ?? r.status)}</span>
      <span class="muted">${TYPE[r.type] ?? ''}</span>
      ${unread(r) ? '<span class="dot" title="Новое сообщение"></span>' : ''}
    </span>
    <span class="row-sub">${esc(r.steam_id)} · ${shortDate(r.created_at)}${r.source === 'web' ? ' · с сайта' : ''}</span>
  </button>`;

const renderList = () => {
  $('list').innerHTML = state.rows.length
    ? state.rows.map(rowHtml).join('')
    : '<p class="empty" style="padding:14px">Ничего не найдено.</p>';
  for (const node of $('list').querySelectorAll('.row')) {
    node.onclick = () => openRequest(Number(node.dataset.id));
  }
};

const loadList = async ({ append = false } = {}) => {
  const data = await api('list', {
    params: { status: state.filter, sort: state.sort, q: state.q, offset: append ? state.offset : 0 },
  });
  if (!append) state.offset = 0;
  state.rows = append ? [...state.rows, ...data.rows] : data.rows;
  $('more').hidden = !data.more;
  renderList();
  return data;
};

const reload = () => loadList().catch(() => {});

// ── Заявка ───────────────────────────────────────────────────────────

const fact = (label, value, mono) =>
  value ? `<div><span class="k">${label}</span><span${mono ? ' class="mono"' : ''}>${esc(value)}</span></div>` : '';

const facts = (r) => [
  r.type === 'privilege' ? fact('Причина', r.reason) : '',
  r.type === 'donate' ? fact('Сумма', `${r.amount} кредитов`) : '',
  r.type === 'donate' ? fact('Оплата', r.payment_method) : '',
  r.type === 'donate' ? fact('Дата платежа', r.paid_at && fullDate(r.paid_at)) : '',
  fact('SteamID', r.steam_id, true),
  fact('Сервер', r.server),
  fact('Подана', dateTime(r.created_at)),
  r.telegram_id
    ? fact('Telegram', `${r.telegram_name ?? ''} · id ${r.telegram_id}`, true)
    : fact('Discord', `${r.discord ?? '-'} (с сайта)`, true),
  fact('Комментарий', r.comment),
].join('');

const shotHtml = (r) => {
  if (r.tg_file_id) {
    const url = fileUrl(r.tg_file_id);
    return `<p><a href="${url}" target="_blank" rel="noopener"><img class="shot" src="${url}" alt="Скриншот заявки"></a></p>`;
  }
  if (r.screenshot_url) {
    return `<p><a href="${esc(r.screenshot_url)}" target="_blank" rel="noopener">Скриншот (ссылка с сайта)</a></p>`;
  }
  return '';
};

const renderHead = () => {
  const { row, blocked } = state.data;
  $('head').innerHTML = `
    <button type="button" class="chip back" id="back">← Список</button>
    <h2>${row.type === 'privilege' ? '🟣 Вернуть привилегию' : '🟡 Не пришёл донат'}
      <span class="mono muted">#${row.id}</span>
      <span class="tag ${row.status}">${esc(STATUS[row.status] ?? row.status)}</span>
    </h2>
    <div class="facts">${facts(row)}</div>
    ${shotHtml(row)}
    <div class="head-tools" id="tools"></div>
    <label class="note">
      <span>Заметка (игрок её не видит)</span>
      <textarea class="field" id="note" rows="2">${esc(row.admin_note)}</textarea>
    </label>`;

  const tools = $('tools');
  for (const [key, label] of Object.entries(SET_STATUS)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(row.status === key));
    chip.onclick = () => setStatus(key);
    tools.append(chip);
  }
  if (row.telegram_id) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip danger';
    chip.textContent = blocked ? '✅ Разблокировать' : '🚫 Заблокировать';
    chip.setAttribute('aria-pressed', String(blocked));
    chip.onclick = () => toggleBlock();
    tools.append(chip);
  }

  $('back').onclick = () => document.body.classList.remove('picked');

  // Скриншот мог быть PDF или слишком большим файлом - тогда просто ссылка.
  const shot = $('head').querySelector('.shot');
  if (shot) {
    shot.onerror = () => {
      shot.replaceWith(Object.assign(document.createElement('span'), { textContent: '📎 файл не показать, откройте ссылку' }));
    };
  }

  const note = $('note');
  let saved = note.value;
  note.onblur = async () => {
    if (note.value === saved) return;
    saved = note.value;
    await api('note', { method: 'POST', body: { id: row.id, note: note.value } });
    state.data.row.admin_note = note.value;
  };
};

const msgHtml = (m) => {
  let media = '';
  if (m.tg_file_id) {
    const url = fileUrl(m.tg_file_id);
    if (['photo', 'animation', 'sticker'].includes(m.tg_file_kind)) {
      media = `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt=""></a>`;
    } else if (['voice', 'audio'].includes(m.tg_file_kind)) {
      media = `<audio controls src="${url}"></audio>`;
    } else if (['video', 'video_note'].includes(m.tg_file_kind)) {
      media = `<video controls src="${url}"></video>`;
    } else {
      media = `<a href="${url}" target="_blank" rel="noopener">📎 файл</a>`;
    }
  }
  const from = m.from_admin ? (m.via === 'web' ? ' · с сайта' : ' · из бота') : '';
  return `<div class="msg ${m.from_admin ? 'mine' : ''}">${esc(m.text)}${media}<time>${dateTime(m.created_at)}${from}</time></div>`;
};

const renderChat = () => {
  const { messages, row } = state.data;
  $('chat').innerHTML = messages.length
    ? messages.map(msgHtml).join('')
    : '<p class="empty">Переписки пока нет. История ведётся с момента, как панель заработала.</p>';
  const toBottom = () => { $('chat').scrollTop = $('chat').scrollHeight; };
  toBottom();
  // Картинки подгружаются после отрисовки и сдвигают низ чата.
  for (const img of $('chat').querySelectorAll('img')) img.onload = toBottom;
  state.lastMsg = messages.at(-1)?.id ?? 0;

  const closed = ['done', 'rejected'].includes(row.status);
  $('composer').hidden = !row.telegram_id;
  $('send-hint').textContent = !row.telegram_id
    ? ''
    : closed ? 'Заявка закрыта: игрок по ней писать не может, но ваш ответ дойдёт.' : '';
};

async function openRequest(id) {
  const data = await api('request', { params: { id } });
  if (data.error) return;
  state.id = id;
  state.data = data;
  document.body.classList.add('picked');
  renderHead();
  renderChat();
  renderTemplateChips();
  for (const node of $('list').querySelectorAll('.row')) {
    node.setAttribute('aria-current', String(Number(node.dataset.id) === id));
  }
  // Точка непрочитанного гаснет: сервер уже записал last_seen_at.
  const listed = state.rows.find((r) => r.id === id);
  if (listed) {
    listed.last_seen_at = new Date().toISOString();
    renderList();
  }
}

// ── Действия ─────────────────────────────────────────────────────────

const setStatus = async (status) => {
  const r = await api('status', { method: 'POST', body: { id: state.id, status } });
  if (r.error) return alert(r.error);
  state.data.row = r.row;
  renderHead();
  renderChat();
  reload();
};

const toggleBlock = async () => {
  const r = await api('block', { method: 'POST', body: { id: state.id } });
  if (r.error) return alert(r.error);
  state.data.blocked = r.blocked;
  renderHead();
};

const sendAnswer = async () => {
  const field = $('answer');
  const value = field.value.trim();
  if (!value) return;
  const button = $('composer').querySelector('.send');
  button.disabled = true;
  $('send-hint').textContent = 'Отправляю…';
  try {
    const r = await api('send', { method: 'POST', body: { id: state.id, text: value } });
    if (r.error) {
      $('send-hint').textContent = r.error;
      return;
    }
    field.value = '';
    $('send-hint').textContent = 'Отправлено.';
    state.data.messages.push(r.message);
    renderChat();
  } finally {
    button.disabled = false;
  }
};

// ── Шаблоны ──────────────────────────────────────────────────────────

const loadTemplates = async () => {
  const { rows } = await api('templates');
  state.templates = rows ?? [];
  renderTemplateChips();
  renderTemplateList();
};

const renderTemplateChips = () => {
  const node = $('template-chips');
  node.innerHTML = '';
  for (const t of state.templates) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = t.text;
    chip.title = t.text;
    chip.onclick = () => {
      const field = $('answer');
      field.value = field.value ? `${field.value.trimEnd()}\n${t.text}` : t.text;
      field.focus();
    };
    node.append(chip);
  }
};

const renderTemplateList = () => {
  const node = $('template-list');
  node.innerHTML = state.templates.length ? '' : '<p class="empty">Шаблонов пока нет.</p>';
  for (const t of state.templates) {
    const item = document.createElement('div');
    item.className = 'template-item';
    item.innerHTML = `<textarea class="field" rows="2">${esc(t.text)}</textarea>
      <button type="button" class="chip" title="Удалить">✖</button>`;
    const [field, remove] = [item.querySelector('textarea'), item.querySelector('button')];
    field.onblur = async () => {
      if (field.value.trim() === t.text || !field.value.trim()) return;
      await api('templates', { method: 'POST', body: { id: t.id, text: field.value } });
      await loadTemplates();
    };
    remove.onclick = async () => {
      await api('templates', { method: 'DELETE', params: { id: t.id } });
      await loadTemplates();
    };
    node.append(item);
  }
};

// ── Опрос ────────────────────────────────────────────────────────────

const tick = async () => {
  if (document.visibilityState !== 'visible') return;
  try {
    // Догруженные страницы опрос не сбрасывает: обновляем, только пока
    // показана первая.
    if (!state.offset) await loadList();
    if (!state.id) return;

    const data = await api('request', { params: { id: state.id } });
    if (data.error) return;
    const changed = data.row.status !== state.data.row.status || data.blocked !== state.data.blocked;
    const note = $('note');
    state.data = { ...data, row: { ...data.row, ...(note ? { admin_note: note.value } : {}) } };
    // Шапку трогаем только при реальном изменении: иначе затрём заметку,
    // которую в этот момент печатают.
    if (changed && note !== document.activeElement) renderHead();
    if ((data.messages.at(-1)?.id ?? 0) !== state.lastMsg) renderChat();
  } catch {
    // Сеть мигнула - просто ждём следующего тика.
  }
};

// ── Запуск ───────────────────────────────────────────────────────────

// Фильтры и сортировка. После выбора рисуем заново - подсветка выбранного
// живёт в самих чипах.
const bindChips = () => {
  chips($('filters'), FILTERS, state.filter, (key) => {
    state.filter = key;
    bindChips();
    reload();
  });
  chips($('sorts'), SORTS, state.sort, (key) => {
    state.sort = key;
    bindChips();
    reload();
  });
};

const start = async () => {
  const me = await api('me');
  if (!me.id) return;
  $('login').hidden = true;
  $('app').hidden = false;
  $('whoami').textContent = `админ id ${me.id}`;

  bindChips();
  await loadList();
  await loadTemplates();
  polling = setInterval(tick, POLL);
};

let searchTimer;
$('search').oninput = (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = event.target.value.trim();
    reload();
  }, 350);
};

$('more').onclick = async () => {
  state.offset = state.rows.length; // следующая страница начинается там, где кончилась загруженная
  await loadList({ append: true });
};

$('composer').onsubmit = (event) => {
  event.preventDefault();
  sendAnswer();
};

$('answer').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
};

$('open-templates').onclick = () => $('templates').showModal();

$('template-add').onsubmit = async (event) => {
  event.preventDefault();
  const field = $('template-text');
  if (!field.value.trim()) return;
  await api('templates', { method: 'POST', body: { text: field.value } });
  field.value = '';
  await loadTemplates();
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') tick();
});

start().catch((error) => {
  console.error('panel', error);
  showGate();
});
