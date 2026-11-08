# Supabase-side pieces (project `dgnxbcoxdpdloplkcmzs`)

The app is still just `index.html`; this folder is the record of what lives server-side.

| Piece | Where |
|---|---|
| `schema.sql` | Reference copy of every `tora_*` table, index, policy. |
| `migrations/tora_reminders.sql` | Push subscriptions, reminder log, `tora_claim_reminders()`, `tora_reminder_secrets()` (service role only). |
| `functions/tora-reminders/index.ts` | Edge function, `verify_jwt = false`; authenticates the cron with `x-cron-secret`. |
| Vault | `tora_cron_secret` (Tora's own). VAPID keys are Ledger's `ledger_vapid_public` / `ledger_vapid_private`, read only; `VAPID_PUBLIC` in `index.html` must match. |
| pg_cron `tora-reminders` | Every 5 minutes, `net.http_post` to the function. |

Ledger's own tables, `send-reminders` function and `ledger-reminders` job are not touched.

How a reminder fires: every 5 minutes `tora_claim_reminders()` inserts, in one statement, every `(block, deadline, offset)` with `deadline − offset ≤ now < deadline` that isn't logged yet, and returns them. The function pushes only the closest offset per block ("«X» σε 15'"), so a deadline set 16' ahead with all three reminders sends one notification, not two. Devices the push service reports gone (404/410) are deleted.
