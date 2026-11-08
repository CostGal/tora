-- Reference copy of the Τώρα schema. Applied as migration `tora_app_schema`
-- on project dgnxbcoxdpdloplkcmzs (shared with Ledger, Overtime, Kitchen),
-- extended by migration `tora_oneoffs_deadlines_progress`.
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
  -- null = weekly template row. Set = one-off on that date (weekday still filled);
  -- its pos is then an anchor: the index among that day's template rows it sits before.
  date date,
  deadline timestamptz,
  remind_min int[] check (remind_min is null or remind_min <@ array[60,30,15]),
  -- one-off that stands in for this template row on its date
  replaces uuid references public.tora_blocks(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tora_blocks_user_day on public.tora_blocks (user_id, weekday, pos);
create index tora_blocks_user_date on public.tora_blocks (user_id, date) where date is not null;
create index tora_blocks_deadline on public.tora_blocks (deadline) where deadline is not null;
create index tora_blocks_replaces on public.tora_blocks (replaces) where replaces is not null;
create table public.tora_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  pos integer not null,
  block_id uuid references public.tora_blocks(id) on delete set null,
  name text not null default '',
  tag text not null default 'other',
  -- d = done, s = skipped, p = in progress (started_at set when started)
  status text not null check (status in ('d','s','p')),
  at timestamptz not null default now(),
  started_at timestamptz,
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

-- Deadline reminders (migration `tora_reminders`, full text in migrations/tora_reminders.sql)
create table public.tora_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create table public.tora_reminder_log (
  block_id uuid not null references public.tora_blocks(id) on delete cascade,
  deadline timestamptz not null,
  offset_min int not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (block_id, deadline, offset_min)
);
alter table public.tora_push_subscriptions enable row level security;
alter table public.tora_reminder_log enable row level security;
create policy tora_push_subscriptions_own on public.tora_push_subscriptions for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy tora_reminder_log_read_own on public.tora_reminder_log for select to authenticated using ((select auth.uid()) = user_id);
-- plus tora_claim_reminders() / tora_reminder_secrets(): service role only.

-- Secret links for tora-api (migration `tora_tokens`)
create table public.tora_tokens (
  token text primary key default encode(extensions.gen_random_bytes(24), 'hex'),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('ics','mcp')),
  created_at timestamptz not null default now(),
  unique (user_id, kind)
);
alter table public.tora_tokens enable row level security;
create policy tora_tokens_own on public.tora_tokens for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create index tora_events_block on public.tora_events (block_id) where block_id is not null;
