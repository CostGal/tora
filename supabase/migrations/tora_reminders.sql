-- Applied as migration `tora_reminders` on dgnxbcoxdpdloplkcmzs.
-- Deadline reminders as Web Push. Pattern copied from Ledger
-- (supabase/migrations/20260927_reminders.sql there); objects are Tora's own.
-- Secrets live in Vault, never here: `tora_cron_secret` (created below with a
-- random value) plus Ledger's `ledger_vapid_public` / `ledger_vapid_private`,
-- which are reused read-only.

create table public.tora_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index tora_push_subscriptions_user on public.tora_push_subscriptions (user_id);
alter table public.tora_push_subscriptions enable row level security;
create policy tora_push_subscriptions_own on public.tora_push_subscriptions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Keyed on the deadline too, so moving a deadline makes its reminders due again.
create table public.tora_reminder_log (
  block_id uuid not null references public.tora_blocks(id) on delete cascade,
  deadline timestamptz not null,
  offset_min int not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (block_id, deadline, offset_min)
);
create index tora_reminder_log_user on public.tora_reminder_log (user_id);
alter table public.tora_reminder_log enable row level security;
create policy tora_reminder_log_read_own on public.tora_reminder_log for select to authenticated
  using ((select auth.uid()) = user_id);

-- Claims every due offset (deadline - offset <= now < deadline) not yet logged,
-- in one statement, and returns it. Overlapping runs hit the primary key.
create or replace function public.tora_claim_reminders()
returns table (block_id uuid, user_id uuid, name text, deadline timestamptz, offset_min int)
language sql security definer set search_path = public as $$
  with ins as (
    insert into tora_reminder_log (block_id, deadline, offset_min, user_id)
    select b.id, b.deadline, o, b.user_id
      from tora_blocks b cross join lateral unnest(b.remind_min) as o
     where b.deadline is not null
       and now() >= b.deadline - make_interval(mins => o)
       and now() < b.deadline
    on conflict do nothing
    returning tora_reminder_log.block_id, tora_reminder_log.deadline, tora_reminder_log.offset_min, tora_reminder_log.user_id
  )
  select ins.block_id, ins.user_id, b.n, ins.deadline, ins.offset_min
    from ins join tora_blocks b on b.id = ins.block_id;
$$;
revoke all on function public.tora_claim_reminders() from public, anon, authenticated;
grant execute on function public.tora_claim_reminders() to service_role;

select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'tora_cron_secret', 'x-cron-secret for the tora-reminders edge function');

create or replace function public.tora_reminder_secrets()
returns json
language sql security definer set search_path = public as $$
  select json_object_agg(name, decrypted_secret)
    from vault.decrypted_secrets
   where name in ('ledger_vapid_public','ledger_vapid_private','tora_cron_secret');
$$;
revoke all on function public.tora_reminder_secrets() from public, anon, authenticated;
grant execute on function public.tora_reminder_secrets() to service_role;

-- Scheduled separately (not a migration statement), kept here for the record:
-- select cron.schedule('tora-reminders','*/5 * * * *', $c$
--   select net.http_post(
--     url:='https://dgnxbcoxdpdloplkcmzs.supabase.co/functions/v1/tora-reminders',
--     headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',
--       (select decrypted_secret from vault.decrypted_secrets where name='tora_cron_secret')),
--     body:='{}'::jsonb);
-- $c$);
