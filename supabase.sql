-- Выполнить один раз в Supabase → SQL Editor → New query → Run.

-- ── Таблица заявок ──────────────────────────────────────────────────
create table if not exists public.requests (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  type           text not null check (type in ('privilege','donate')),
  status         text not null default 'new'
                 check (status in ('new','in_progress','done','rejected')),
  steam_id       text not null,
  discord        text not null,
  discord_id     text,          -- id аккаунта из входа через Discord; ник можно сменить, id нет
  server         text,          -- 1 или 2 сервер; игрок мог не указать
  reason         text,          -- возврат привилегии
  amount         integer,       -- донат: сумма кредитов без комиссии
  payment_method text,          -- донат: способ оплаты
  paid_at        timestamptz,   -- донат: когда платил
  screenshot_url text,
  comment        text,
  admin_note     text,          -- твои пометки, игрок их не видит
  ip_hash        text,          -- sha256(ip + соль); для склейки заявок одного человека
  ip             text           -- сырой IP заявки, виден только через service_role
);

-- Если таблица уже создана раньше - добавить недостающие колонки:
alter table public.requests add column if not exists server text;
alter table public.requests add column if not exists ip     text;
alter table public.requests add column if not exists discord_id text;

create index if not exists requests_created_idx on public.requests (created_at desc);
create index if not exists requests_status_idx  on public.requests (status);
create index if not exists requests_ip_idx      on public.requests (ip_hash, created_at desc);
create index if not exists requests_steam_idx   on public.requests (steam_id);

-- RLS включён, политик нет: писать и читать может только service_role
-- (ключ лежит в переменных окружения Vercel). Анонимный ключ не даст ничего.
alter table public.requests enable row level security;

-- ── Хранилище скриншотов ────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', false)
on conflict (id) do nothing;

-- Политик на bucket тоже нет - файлы отдаются только по подписанной ссылке,
-- которую кладём в screenshot_url.

-- ── Бот (api/telegram.js) ───────────────────────────────────────────
-- Только добавляет: сайт продолжает работать и с этой схемой.
-- У заявок из бота нет Discord - ник и id берутся из Telegram.
alter table public.requests alter column discord drop not null;
alter table public.requests add column if not exists telegram_id   bigint;
alter table public.requests add column if not exists telegram_name text;  -- @username или имя
alter table public.requests add column if not exists tg_file_id    text;  -- файл остаётся в Telegram
alter table public.requests add column if not exists tg_file_kind  text;  -- document | photo
-- Умолчание 'web': сайт колонку не пишет и не сломается, даже если этот SQL
-- ещё не выполнен; бот пишет 'tg' сам. Старым заявкам проставится 'web'.
alter table public.requests add column if not exists source        text not null default 'web';
create index if not exists requests_tg_idx on public.requests (telegram_id, created_at desc);

-- Черновик анкеты: вебхук не помнит ничего между сообщениями.
create table if not exists public.tg_state (
  chat_id    bigint primary key,
  step       text not null,
  draft      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- Какое сообщение в чате админа к какой заявке относится: ответ на любое из
-- них уходит игроку этой заявки. message_id уникален только внутри чата,
-- поэтому ключ - пара (чат, сообщение).
create table if not exists public.tg_thread (
  admin_chat_id bigint not null,
  admin_msg_id  bigint not null,
  request_id    bigint not null references public.requests(id) on delete cascade,
  primary key (admin_chat_id, admin_msg_id)
);
create index if not exists tg_thread_request_idx on public.tg_thread (request_id, admin_chat_id);

alter table public.tg_state  enable row level security;
alter table public.tg_thread enable row level security;

-- Заблокированные игроки: ни заявок, ни сообщений в поддержку.
create table if not exists public.tg_blocked (
  telegram_id bigint primary key,
  blocked_at  timestamptz not null default now()
);
alter table public.tg_blocked enable row level security;

-- ── Админ-панель на сайте (api/admin.js) ────────────────────────────
-- Переписка. Раньше её нигде не было: бот только пересылал сообщения в чат
-- админа. Панели нужен чат, поэтому каждое сообщение в обе стороны пишется сюда.
-- История начинается с момента выполнения этого SQL: что было сказано раньше,
-- осталось только в чате Telegram.
create table if not exists public.messages (
  id           bigserial primary key,
  request_id   bigint not null references public.requests(id) on delete cascade,
  created_at   timestamptz not null default now(),
  from_admin   boolean not null,
  admin_id     bigint,        -- кто из админов ответил; у сообщений игрока null
  text         text,
  tg_file_id   text,          -- файл остаётся в Telegram, как и в заявках
  tg_file_kind text,          -- photo | document | voice | video | audio | animation
  via          text not null default 'tg'  -- 'tg' - из чата бота, 'web' - из панели
);
create index if not exists messages_request_idx on public.messages (request_id, id);
alter table public.messages enable row level security;

-- Непрочитанное считаем сравнением двух дат, без счётчиков:
-- last_player_at > last_seen_at - игрок написал после того, как ты открывал заявку.
alter table public.requests add column if not exists last_player_at timestamptz;
alter table public.requests add column if not exists last_seen_at   timestamptz;

-- Шаблоны ответов, настраиваются в панели.
create table if not exists public.reply_templates (
  id   bigserial primary key,
  text text not null,
  sort integer not null default 0
);
alter table public.reply_templates enable row level security;
