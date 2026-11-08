-- Applied as migrations `tora_tokens` and `tora_events_block_idx` on dgnxbcoxdpdloplkcmzs.
-- Personal secret links for the tora-api edge function:
--   'ics' = read-only calendar feed, 'mcp' = Claude connector (read/write).
-- One of each per user; regenerating = delete + insert (the old link stops working).
create table public.tora_tokens (
  token text primary key default encode(extensions.gen_random_bytes(24), 'hex'),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('ics','mcp')),
  created_at timestamptz not null default now(),
  unique (user_id, kind)
);
alter table public.tora_tokens enable row level security;
create policy tora_tokens_own on public.tora_tokens for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create index if not exists tora_events_block on public.tora_events (block_id) where block_id is not null;
