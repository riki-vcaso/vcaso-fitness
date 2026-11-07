-- VCASO Fitness: data lives beside the other VCASO apps, every table prefixed fx_.
-- A driver reads and writes only their own rows. Wearable tokens are server-only.

create table if not exists public.fx_profile (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,   -- stats, targets, baseline, settings
  notify_wd   text  not null default '07:00',       -- weekday morning alert (local)
  notify_we   text  not null default '08:30',       -- weekend morning alert (local)
  notify_on   boolean not null default true,
  tz          text  not null default 'Europe/London',
  updated_at  timestamptz not null default now()
);

create table if not exists public.fx_day (
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        date not null,
  data        jsonb not null default '{}'::jsonb,   -- session status, check-in, food, water, weight, drills
  plan_title  text,                                 -- written by the app so the morning alert can name the session
  updated_at  timestamptz not null default now(),
  primary key (user_id, date)
);

create table if not exists public.fx_activity (
  user_id     uuid not null references auth.users(id) on delete cascade,
  source      text not null,                        -- strava (Garmin auto-sync) | manual
  ext_id      text not null,
  date        date not null,                        -- local date of the start
  start_at    timestamptz,
  sport       text,
  name        text,
  dur_s       integer,
  dist_m      numeric,
  avg_hr      numeric,
  max_hr      numeric,
  kj          numeric,
  created_at  timestamptz not null default now(),
  primary key (source, ext_id)
);
create index if not exists fx_activity_user_date on public.fx_activity (user_id, date);

create table if not exists public.fx_oura (
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        date not null,
  readiness   integer,
  sleep_score integer,
  sleep_s     integer,
  hrv         numeric,
  rhr         numeric,
  temp_dev    numeric,
  steps       integer,
  updated_at  timestamptz not null default now(),
  primary key (user_id, date)
);

-- OAuth tokens: RLS on, no policies, so only the service role (edge functions) can read them.
create table if not exists public.fx_tokens (
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider    text not null,
  access      text,
  refresh     text,
  expires_at  timestamptz,
  ext_user    text,
  updated_at  timestamptz not null default now(),
  primary key (user_id, provider)
);

create table if not exists public.fx_push_subs (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  sub         jsonb not null,
  ua          text,
  created_at  timestamptz not null default now()
);

create table if not exists public.fx_push_log (
  tag         text primary key,
  sent_at     timestamptz not null default now()
);

alter table public.fx_profile   enable row level security;
alter table public.fx_day       enable row level security;
alter table public.fx_activity  enable row level security;
alter table public.fx_oura      enable row level security;
alter table public.fx_tokens    enable row level security;
alter table public.fx_push_subs enable row level security;
alter table public.fx_push_log  enable row level security;

create policy fx_profile_own  on public.fx_profile  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy fx_day_own      on public.fx_day      for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy fx_activity_own on public.fx_activity for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy fx_oura_read    on public.fx_oura     for select to authenticated using (user_id = (select auth.uid()));
create policy fx_push_own     on public.fx_push_subs for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.fx_profile, public.fx_day, public.fx_activity, public.fx_push_subs to authenticated;
grant select on public.fx_oura to authenticated;
revoke all on public.fx_tokens, public.fx_push_log from anon, authenticated;

-- Which wearables are linked, without exposing the tokens.
create or replace function public.fx_links()
returns table(provider text, linked_at timestamptz)
language sql security definer set search_path = public stable as $$
  select provider, updated_at from public.fx_tokens where user_id = auth.uid();
$$;
revoke execute on function public.fx_links() from anon, public;
grant execute on function public.fx_links() to authenticated;

-- Brake Trainer runs this week count towards cognitive work.
create or replace function public.fx_bt_runs(since date)
returns table(day date, runs bigint, best numeric)
language sql security definer set search_path = public stable as $$
  select (created_at at time zone 'Europe/London')::date, count(*), max(overall)
  from public.bt_runs where user_id = auth.uid() and created_at >= since
  group by 1;
$$;
revoke execute on function public.fx_bt_runs(date) from anon, public;
grant execute on function public.fx_bt_runs(date) to authenticated;
