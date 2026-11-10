-- Reminders relative to a step's START (weekly steps, and one-offs without a deadline),
-- plus a 5' offset. NOT yet applied to dgnxbcoxdpdloplkcmzs: apply as migration `tora_reminders_start`.
--
-- 1) remind_min may now contain 5.
-- 2) tora_claim_reminders() also claims start-based reminders:
--    * weekly row (date is null), no deadline, remind_min set, t starts with a clock time
--      -> one occurrence per plan day (Europe/Athens; the day rolls over at 04:00, so 00:00-03:59
--         belongs to the previous plan day and happens the next calendar night);
--    * one-off row without deadline -> its own date.
--    A weekly occurrence is skipped on a date where a one-off `replaces` it (that one-off has its
--    own reminder), and when the step already has an event (done / skipped / started) that day.
--    The reference timestamp of an occurrence goes into the existing `deadline` column of
--    tora_reminder_log, so the PK (block_id, deadline, offset_min) = once per occurrence.
--    Rows with a deadline behave exactly as before. New output column `kind` ('deadline' | 'start').

alter table public.tora_blocks drop constraint if exists tora_blocks_remind_min_check;
alter table public.tora_blocks add constraint tora_blocks_remind_min_check
  check (remind_min is null or remind_min <@ array[60,30,15,5]);

drop function if exists public.tora_claim_reminders();
create function public.tora_claim_reminders()
returns table (block_id uuid, user_id uuid, name text, deadline timestamptz, offset_min int, kind text)
language sql security definer set search_path = public as $$
  with
  athens as (select (now() at time zone 'Europe/Athens')::date as d),
  cand as (
    -- (a) existing: step with a deadline
    select b.id as block_id, b.user_id, b.n, b.deadline as ref, b.remind_min, 'deadline'::text as kind
      from tora_blocks b
     where b.deadline is not null and b.remind_min is not null
    union all
    -- (b) new: start of a weekly step on plan day pd, or of a one-off on its date
    select s.id, s.user_id, s.n,
           ((s.pd + case when s.h < 4 then 1 else 0 end)::timestamp + make_interval(hours => s.h, mins => s.m))
             at time zone 'Europe/Athens',
           s.remind_min, 'start'
      from (
        select b.id, b.user_id, b.n, b.remind_min,
               pd.d as pd,
               substring(b.t from '^~?\s*(\d{1,2})[:.]\d{2}')::int as h,
               substring(b.t from '^~?\s*\d{1,2}[:.](\d{2})')::int as m
          from tora_blocks b
          cross join lateral (
            select x as d from (
              select b.date as x where b.date is not null
              union all
              select a.d - 1 from athens a where b.date is null
              union all
              select a.d from athens a where b.date is null
            ) q
            where b.date is not null or extract(dow from x)::int = b.weekday
          ) pd
         where b.deadline is null and b.remind_min is not null
           and b.t ~ '^~?\s*\d{1,2}[:.]\d{2}'
           and not exists (select 1 from tora_blocks o where o.replaces = b.id and o.date = pd.d)
           and not exists (select 1 from tora_events e where e.block_id = b.id and e.date = pd.d)
      ) s
     where s.h < 24 and s.m < 60
  ),
  ins as (
    insert into tora_reminder_log (block_id, deadline, offset_min, user_id)
    select c.block_id, c.ref, o, c.user_id
      from cand c cross join lateral unnest(c.remind_min) as o
     where now() >= c.ref - make_interval(mins => o)
       and now() < c.ref
    on conflict do nothing
    returning tora_reminder_log.block_id, tora_reminder_log.deadline, tora_reminder_log.offset_min, tora_reminder_log.user_id
  )
  select ins.block_id, ins.user_id, c.n, ins.deadline, ins.offset_min, c.kind
    from ins join cand c on c.block_id = ins.block_id and c.ref = ins.deadline;
$$;
revoke all on function public.tora_claim_reminders() from public, anon, authenticated;
grant execute on function public.tora_claim_reminders() to service_role;
