// tora-reminders — deadline reminders for Τώρα as Web Push.
//
// Called by pg_cron every 5 minutes with header x-cron-secret (Vault
// `tora_cron_secret`). tora_claim_reminders() claims every due reminder offset
// in one statement (so overlapping runs can't double-send) and returns them.
// Per block only the closest due offset is pushed; any earlier offsets claimed
// in the same run (e.g. the cron was down, or the deadline was set 16' ahead
// with "1 ώρα πριν") are dropped silently, so one deadline never gets a burst.
//
// Deployed with verify_jwt = false: the only caller is the scheduler and it
// authenticates with the cron secret below. VAPID keys are Ledger's (same
// project, read from Vault via tora_reminder_secrets()).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };
type Due = { block_id: string; user_id: string; name: string; deadline: string; offset_min: number };

function when(r: Due) {
  const left = Math.max(1, Math.round((new Date(r.deadline).getTime() - Date.now()) / 60000));
  // On time (the 5' cron makes it up to ~5' late): say the offset. Later than that: say what's left.
  const m = left >= r.offset_min - 5 ? r.offset_min : left;
  return m >= 60 ? "σε 1 ώρα" : `σε ${m}'`;
}

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: sec, error: secErr } = await sb.rpc("tora_reminder_secrets");
  if (secErr || !sec?.ledger_vapid_private || !sec?.tora_cron_secret) return json({ error: "secrets missing" }, 500);
  if (req.headers.get("x-cron-secret") !== sec.tora_cron_secret) return json({ error: "forbidden" }, 403);
  webpush.setVapidDetails("https://costgal.github.io/tora/", sec.ledger_vapid_public, sec.ledger_vapid_private);

  const { data: due, error } = await sb.rpc("tora_claim_reminders");
  if (error) return json({ error: error.message }, 500);

  const best = new Map<string, Due>();
  for (const r of (due ?? []) as Due[]) {
    const k = r.block_id;
    if (!best.has(k) || r.offset_min < best.get(k)!.offset_min) best.set(k, r);
  }

  let sent = 0;
  for (const r of best.values()) {
    const { data: subs } = await sb.from("tora_push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", r.user_id);
    const payload = JSON.stringify({ title: "Τώρα", body: `«${r.name}» ${when(r)}`, tag: `${r.block_id}-${r.offset_min}` });
    for (const s of (subs ?? []) as Sub[]) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 1800 });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sb.from("tora_push_subscriptions").delete().eq("id", s.id);
        else console.error("push failed", code, (e as Error).message);
      }
    }
  }
  return json({ claimed: (due ?? []).length, reminders: best.size, sent });
});
