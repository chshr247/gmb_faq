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
  reason         text,          -- возврат привилегии
  amount         integer,       -- донат: сумма кредитов без комиссии
  payment_method text,          -- донат: способ оплаты
  paid_at        timestamptz,   -- донат: когда платил
  screenshot_url text,
  comment        text,
  admin_note     text,          -- твои пометки, игрок их не видит
  ip_hash        text           -- sha256(ip + соль); сам IP не храним
);

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

-- Политик на bucket тоже нет — файлы отдаются только по подписанной ссылке,
-- которую кладём в screenshot_url.
