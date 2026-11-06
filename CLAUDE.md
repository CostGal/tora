# CLAUDE.md

## What this is

**Τώρα** — Kostas's now/next daily plan. One screen tells him the current step and the next one, with ✓ / Παράλειψη. Its job is to remove the "what do I do next?" decision when he's tired. Fourth sibling of Ledger · Overtime · Kitchen on `costgal.github.io`. A planned future step is merging it with Ledger. Not now.

The app is one static file, `index.html`: vanilla JS/CSS, no build step, no dependencies, Supabase over `fetch`. UI copy is in Greek.

## Views

- **Τώρα**: the sequence for today. Each ✓ or skip writes a `tora_events` row with a timestamp. The day rolls over at 04:00.
- **Εβδομάδα**: the weekly template, one column per day, plus a month calendar shaded by completion, plus the rules.
- **Μοτίβα**: the insights. They cover overtime vs rest length, overtime vs gym/PR completion, completion per weekday, and completion per step. Overtime comes from the Overtime app's `ot_entries`, which uses the same account and is protected by RLS.

## Demo mode

Demo mode runs when you open the page via `file://` or with `?demo`. It needs no network and stores a fake account with about 6 weeks of history in `localStorage` (`tora-demo-v1`). Use it for all UI work, and run `python3 tools/shot.py [url]` for headless Chrome screenshots. Both backends implement the same interface (`load`, `upsertBlocks`, `deleteBlocks`, `putEvent`, `delEvent`, `saveRules`), so UI code never branches on DEMO.

## Backend

- Supabase project `dgnxbcoxdpdloplkcmzs` (personal, shared with the siblings). All tables are prefixed `tora_`. Never touch other apps' tables. The one exception: reading `ot_entries`, select only.
- RLS on every table: `user_id = auth.uid()`. The key in the file is publishable.
- Schema is in `supabase/schema.sql`. Apply changes via the Supabase MCP `apply_migration` and update that file in the same commit.
- **Shared session**: key `costgal_session_<ref>`, with `rotatedSession` plus a `storage` listener. Copied from Overtime, so keep it identical.
- Writes are optimistic. Mutate `S`, then `track(DB.x())`. Failures surface as a toast and a red sync dot.
- `saveDays(weekdays, deletedIds)` renumbers each touched day's `pos` to 0..n-1 and upserts the whole day. Every template edit goes through it.

## Design

Pond background on a canvas (koi, lily pads, ripples on every touch) with glass cards (`.glass`). `.tilt` cards lean toward the finger, and `.tap` elements press and ripple. The accent is `#D97757`. Use the Futura/Jost stack. iOS-first: 44pt taps, safe-area insets, 16px inputs so iOS doesn't zoom.

## Deploy

GitHub Pages from `main`, repo root, at `https://costgal.github.io/tora/`. Keep all asset URLs relative.
