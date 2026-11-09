-- Applied as migration `tora_nested_steps` on dgnxbcoxdpdloplkcmzs.
-- A step that happens inside another one ("φαγητό" during "δουλειά").
-- The host is never stored: it is the step whose window covers this step's start
-- (windows() in index.html and tora-api). If none covers it, the step is a normal one.
alter table public.tora_blocks add column if not exists nested boolean not null default false;
