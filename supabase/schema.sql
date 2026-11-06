-- Reference copy of the Τώρα schema. Applied as migration `tora_app_schema`
-- on project dgnxbcoxdpdloplkcmzs (shared with Ledger, Overtime, Kitchen).
create table public.tora_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  pos integer not null default 0,
  t text not null default '',
  n text not null,
  h text not null default '',
  list jsonb,
  tag text not null default 'other' check (tag in ('work','rest','gym','pr','home','partner','sleep','food','other')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tora_blocks_user_day on public.tora_blocks (user_id, weekday, pos);
create table public.tora_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  pos integer not null,
  block_id uuid references public.tora_blocks(id) on delete set null,
  name text not null default '',
  tag text not null default 'other',
  status text not null check (status in ('d','s')),
  at timestamptz not null default now(),
  unique (user_id, date, pos)
);
create index tora_events_user_date on public.tora_events (user_id, date);
create table public.tora_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  rules jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.tora_blocks enable row level security;
alter table public.tora_events enable row level security;
alter table public.tora_settings enable row level security;
create policy tora_blocks_own on public.tora_blocks for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy tora_events_own on public.tora_events for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy tora_settings_own on public.tora_settings for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
