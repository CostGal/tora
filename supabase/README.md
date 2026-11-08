# Supabase-side pieces (project `dgnxbcoxdpdloplkcmzs`)

The app is still just `index.html`; this folder is the record of what lives server-side.

| Piece | Where |
|---|---|
| `schema.sql` | Reference copy of every `tora_*` table, index, policy. |
| `migrations/tora_reminders.sql` | Push subscriptions, reminder log, `tora_claim_reminders()`, `tora_reminder_secrets()` (service role only). |
| `functions/tora-reminders/index.ts` | Edge function, `verify_jwt = false`; authenticates the cron with `x-cron-secret`. |
| Vault | `tora_cron_secret` (Tora's own). VAPID keys are Ledger's `ledger_vapid_public` / `ledger_vapid_private`, read only; `VAPID_PUBLIC` in `index.html` must match. |
| pg_cron `tora-reminders` | Every 5 minutes, `net.http_post` to the function. |
| `migrations/tora_tokens.sql` | `tora_tokens`: one secret per user per kind (`ics`, `mcp`), RLS on `user_id`. |
| `functions/tora-api/index.ts` | Edge function, `verify_jwt = false`; the token in the path is the credential. `GET /tora-api/ics/<token>.ics` = calendar feed, `POST /tora-api/mcp/<token>` = MCP server for Claude. |

Ledger's own tables, `send-reminders` function and `ledger-reminders` job are not touched.

How a reminder fires: every 5 minutes `tora_claim_reminders()` inserts, in one statement, every `(block, deadline, offset)` with `deadline − offset ≤ now < deadline` that isn't logged yet, and returns them. The function pushes only the closest offset per block ("«X» σε 15'"), so a deadline set 16' ahead with all three reminders sends one notification, not two. Devices the push service reports gone (404/410) are deleted.

## Calendar feed and Claude connector (`tora-api`)

Both links are created from the app (Πρόγραμμα → «Ημερολόγιο & Claude»). «Νέος σύνδεσμος» deletes the old token, so the old URL stops working at once.

- **ICS** (read-only). Weekly rows become `RRULE:FREQ=WEEKLY` events starting 4 weeks back. A one-off with `replaces` adds an `EXDATE` to the row it stands in for. One-offs become single events, word or empty times become all-day events, and each deadline becomes a 15' "⏰ Προθεσμία" event. All times are `Europe/Athens` (a VTIMEZONE is included). Google refreshes subscribed calendars on its own schedule (hours), and Notion Calendar shows them through Google.
- **MCP** (Streamable HTTP, stateless JSON responses, protocol 2025-06-18 / 2025-03-26 / 2024-11-05). Tools: `tora_today`, `tora_week`, `tora_add_step` (reports `clashes`), `tora_update_step`, `tora_delete_step`, `tora_mark` (done / skip / start / undo, same event semantics as the app). Plan logic (`planDay`, `windows`, `placeByTime`) is a TypeScript copy of `index.html`, so change both together.
