# CLAUDE.md

## What this is

**Τώρα** — Kostas's now/next daily plan. One screen tells him the current step and the next one, with ✓ / Παράλειψη. Its job is to remove the "what do I do next?" decision when he's tired. Fourth sibling of Ledger · Overtime · Kitchen on `costgal.github.io`. A planned future step is merging it with Ledger. Not now.

The app is one static file, `index.html`: vanilla JS/CSS, no build step, no dependencies, Supabase over `fetch`. `sw.js` exists only for push notifications. UI copy is in Greek.

Keep it minimal. Planning is mainly a desktop activity. Mobile is especially minimal: you look at Τώρα and add things through the + flow.

## Views

The tab bar is icons only. On mobile it reads `[Τώρα] [+] [Πρόγραμμα]` with the accent + in the middle. On desktop (≥1024px) it's a vertical pill in the bottom-left.

- **Τώρα**: today's sequence, centred at max 520px on desktop too. ✓ / Παράλειψη writes a `tora_events` row. **Ξεκίνα** appears once the step's start time has come (or it has no clock time). It writes status `p` + `started_at`. While a step is in progress:
  - the card shows a timer, plus a progress bar if the step has a range or a duration in its title ("45'", "(1h)");
  - the koi circle the card (`ORB` in the pond loop);
  - the card edge glows.

  ✓ keeps `started_at`, and undo goes back to in progress. `prefers-reduced-motion` turns off the orbit and the pulse; the timer stays. The day rolls over at 04:00.
- **Πρόγραμμα**:
  - **Desktop** is a week on a time axis (hours × Δευ…Κυρ), with week navigation. Drag a block to move it (15' snap; Alt/Ctrl/⌘ copies). Drag its bottom edge to resize, which writes a range. Click empty time to create a step there. Click a block to edit it in the side panel (`#side`). Word times ("πρωί") sit in an untimed strip on top.
  - **Mobile** is a read/light-edit list of the next 7 days. Tap a step to get the bottom sheet; ⋯ copies a day. There is no drag & drop on mobile.
- **+**:
  - **Mobile** opens a full-screen flow, one question per screen: Τι; → Πότε; (once: Σήμερα/Αύριο/date, or weekly weekdays) → Τι ώρα; → Προθεσμία; → Πού να μπει;. The last screen shows **only** when the new step's window overlaps an existing block, using the same `windows()` as the grid. It offers before / after / replace / both. Undo comes from the snackbar.
  - **Desktop** opens the side panel instead.

**FEATURES flags**: `const FEATURES={insights:false,rules:false}`. The code stays and is gated by the flag:
- `insights` covers the Μοτίβα tab (`analyse()` / `renderIns`) and the month completion calendar.
- `rules` covers Κανόνες and its editor.

Flip a flag to bring a feature back. Overtime for insights comes from the Overtime app's `ot_entries`, which uses the same account and is protected by RLS.

## Demo mode

Demo mode runs when you open the page via `file://` or with `?demo`. It needs no network and stores a fake account in `localStorage` (`tora-demo-v2`): ~6 weeks of history plus two one-offs, one with a deadline and reminders. Use it for all UI work. Run `python3 tools/shot.py [url] [outdir]` for headless screenshots at 390×844 and 1440×900; it exits 1 on page errors. Both backends implement the same interface (`load`, `upsertBlocks`, `deleteBlocks`, `putEvent`, `delEvent`, `saveRules`), so UI code never branches on DEMO.

## Backend

- Supabase project `dgnxbcoxdpdloplkcmzs` (personal, shared with the siblings). All tables are prefixed `tora_`. Never touch other apps' tables. The one exception: reading `ot_entries`, select only.
- RLS on every table: `user_id = auth.uid()`. The key in the file is publishable.
- Schema is in `supabase/schema.sql`, migrations in `supabase/migrations/`, the edge function in `supabase/functions/`. Apply changes via the Supabase MCP `apply_migration` and update those files in the same commit.
- **Shared session**: key `costgal_session_<ref>`, with `rotatedSession` plus a `storage` listener. Copied from Overtime, so keep it identical.
- Writes are optimistic. Mutate `S`, then `track(DB.x())`. Failures surface as a toast and a red sync dot.

## Data model

**`tora_blocks`** has two kinds of row:
- **Weekly template**: `date` is null. Rows are ordered by `pos`.
- **One-off**: `date` is set, and `weekday` is still filled. Its `pos` is an *anchor*, meaning the index among that day's template rows that it sits before. Setting `replaces = <template id>` hides that template row on that date only; this is "Αντικατάστασε" for a one-off.

Each row may also have a `deadline` (timestamptz) and `remind_min` (a subset of {60,30,15}).

Helper functions:
- `dayBlocks(wd)` returns the template.
- `planDay('YYYY-MM-DD')` returns template + one-offs merged. This is what Τώρα and both Πρόγραμμα views show.
- `saveDays(keys, deletedIds)` takes weekdays (numbers) and/or dates (strings). It renumbers template days to 0..n-1 and upserts one-off rows with their anchor. Every edit goes through it, and `snap(keys)` / `restore()` give undo.
- `placeByTime(b)` puts a block in time order.
- `windows(list)` gives each block its span. A range uses its own span. A single time runs until the next start, with a 30' minimum (`e`, used for clashes), and is drawn until the next start (`ve`). Words are untimed. Times before 04:00 count as the end of the day.

**`tora_events`**: `status` is `d` / `s` / `p`, and `started_at` is set when started. Events are matched to blocks by `block_id`; legacy rows fall back to `pos`. `pos` is unique per date (`freePos`).

## Deadline reminders

A step can have a `deadline` and `remind_min` (any of 60/30/15). Every 5 minutes pg_cron calls the `tora-reminders` edge function, which claims due offsets in one statement (`tora_claim_reminders()`, logged in `tora_reminder_log`). It pushes «X» σε 1 ώρα / 30' / 15' to every device in `tora_push_subscriptions`, only the closest due offset per block. The pattern is copied from Ledger, but the objects are Tora's own. Ledger's tables, function and cron job are never touched. VAPID keys are Ledger's, read from Vault. Details are in `supabase/README.md`.

- `sw.js` is notification-only (scope `/tora/`, no fetch handler).
- The "Ενεργοποίηση ειδοποιήσεων" card shows once, the first time a deadline with a reminder is saved. There is no settings screen.
- iOS delivers web push only to the home-screen app (iOS 16.4+), never to a Safari tab.
- Because of the 5-minute cron, a reminder can arrive up to ~5' late.

## Calendar feed and Claude

The `tora-api` edge function exposes two secret links (`tora_tokens`), managed in Πρόγραμμα → «Ημερολόγιο & Claude»:
- `ics/<token>.ics` is a read-only feed for Google Calendar; Notion Calendar shows it through Google.
- `mcp/<token>` is an MCP server that Claude (a claude.ai custom connector) uses to read the plan, add, edit or delete steps, and mark ✓ / skip / start.

Tora is the source of truth; the calendar only mirrors it. The function repeats the plan logic in TypeScript, so a change to `planDay` / `windows` / `placeByTime` in `index.html` must also go into `supabase/functions/tora-api/index.ts`. Details are in `supabase/README.md`.

## Step time

`t` stays free text in the DB, but the UI only writes it through `timePicker()`, or through drag/resize on the desktop grid, which keeps the `~` and the shape. The allowed shapes are `18:40`, `~18:40` (approximate), `09:00–17:00`, a word (`πρωί`), or empty. `parseT`/`fmtT` convert between the text and the picker state; `parseT("")` has `empty:true` and must be treated as untimed. Any new place that edits time must use the picker rather than a text input.

## Design

Pond background on a canvas (koi, lily pads, ripples on every touch) with glass cards (`.glass`). `.tilt` cards lean toward the finger, and `.tap` elements press and ripple. The accent is `#D97757`. Use the Futura/Jost stack. iOS-first: 44pt taps, safe-area insets, 16px inputs so iOS doesn't zoom.

## Deploy

GitHub Pages from `main`, repo root, at `https://costgal.github.io/tora/`. Keep all asset URLs relative.
