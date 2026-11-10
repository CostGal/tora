// tora-api — Τώρα outside the app. Two routes, each behind its own secret token
// (table tora_tokens, created from the app's «Ημερολόγιο & Claude» sheet):
//
//   GET  /tora-api/ics/<token>   read-only iCalendar feed. Subscribe to it in
//                                Google Calendar (Notion Calendar shows Google's).
//   POST /tora-api/mcp/<token>   MCP server (Streamable HTTP, stateless JSON) so
//                                Claude can read the plan, add/edit/delete steps
//                                and mark them done / skipped / started.
//
// verify_jwt = false: Google and claude.ai send no Supabase JWT; the token in
// the path is the credential. Writes use the service role, always scoped to
// the token's user_id. Plan logic mirrors index.html (planDay, windows,
// placeByTime); keep them in step.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TZ = "Europe/Athens";
const DAYS = ["Κυριακή", "Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο"];
const TAGS = ["work", "rest", "gym", "pr", "home", "partner", "sleep", "food", "other"];
const REMS = [60, 30, 15, 5];
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

type Block = {
  id: string; user_id: string; weekday: number; pos: number; t: string; n: string; h: string;
  list: [string, string][] | null; tag: string; date: string | null; deadline: string | null;
  remind_min: number[] | null; replaces: string | null; nested?: boolean;
};
type Ev = { id?: string; user_id: string; date: string; pos: number; block_id: string | null; name: string; tag: string; status: string; at: string; started_at: string | null };

// ---------- time & dates (Europe/Athens, day rolls over at 04:00) ----------
function parts(d: Date) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute, s: +p.second };
}
const todayKey = () => parts(new Date(Date.now() - 4 * 3600e3)).date;
const wdOf = (dk: string) => new Date(dk + "T12:00:00Z").getUTCDay();
function addDays(dk: string, n: number) { const d = new Date(dk + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nowDM() { const p = parts(new Date()); const m = p.h * 60 + p.m; return m < 240 ? m + 1440 : m; }
/** "YYYY-MM-DDTHH:MM" wall time in Athens → UTC ISO. */
function athensToISO(local: string) {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) throw new Error(`Μη έγκυρη ημερομηνία/ώρα: ${local} (θέλω YYYY-MM-DDTHH:MM)`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const p = parts(new Date(guess));
  const asUTC = Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10), p.h, p.m);
  return new Date(guess - (asUTC - guess)).toISOString();
}
function isoToAthens(iso: string) { const p = parts(new Date(iso)); return `${p.date} ${String(p.h).padStart(2, "0")}:${String(p.m).padStart(2, "0")}`; }
function dateArg(s: string | undefined) {
  if (!s) return todayKey();
  const v = s.trim().toLowerCase();
  if (["today", "σήμερα", "σημερα"].includes(v)) return todayKey();
  if (["tomorrow", "αύριο", "αυριο"].includes(v)) return addDays(todayKey(), 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Μη έγκυρη ημερομηνία: ${s} (θέλω YYYY-MM-DD)`);
  return v;
}
function weekdayArg(x: unknown): number {
  if (typeof x === "number" && x >= 0 && x <= 6) return x;
  const s = String(x).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const names = [["κυρ", "sun"], ["δευ", "mon"], ["τρι", "tue"], ["τετ", "wed"], ["πεμ", "thu"], ["παρ", "fri"], ["σαβ", "sat"]];
  const i = names.findIndex((n) => n.some((p) => s.startsWith(p)));
  if (/^[0-6]$/.test(s)) return +s;
  if (i < 0) throw new Error(`Άγνωστη μέρα: ${x}`);
  return i;
}

// ---------- step time (same shapes as the app's timePicker) ----------
type T = { mode: "time" | "range" | "label" | "empty"; approx?: boolean; a?: string; b?: string; label?: string };
const hm2 = (h: string, m: string) => `${String(Math.min(23, +h)).padStart(2, "0")}:${String(Math.min(59, +m)).padStart(2, "0")}`;
function parseT(t: string): T {
  t = String(t || "").trim();
  if (!t) return { mode: "empty" };
  const m = t.match(/^(~)?\s*(\d{1,2})[:.](\d{2})(?:\s*[–\-]\s*(\d{1,2})[:.](\d{2}))?$/);
  if (m) return m[4] ? { mode: "range", approx: !!m[1], a: hm2(m[2], m[3]), b: hm2(m[4], m[5]) } : { mode: "time", approx: !!m[1], a: hm2(m[2], m[3]) };
  return { mode: "label", label: t };
}
function normT(t: string | undefined) {
  if (t == null) return "";
  const p = parseT(t);
  if (p.mode === "empty") return "";
  if (p.mode === "label") { if (p.label!.length > 30) throw new Error("Η ώρα είναι πολύ μεγάλη. Δώσε 18:40, ~18:40, 09:00–17:00 ή μια λέξη (πρωί)."); return p.label!; }
  return (p.approx ? "~" : "") + p.a + (p.mode === "range" ? "–" + p.b : "");
}
/** Reminders need a reference: the deadline, or (no deadline) the start of a step that has a clock time. */
const hasClock = (t: string) => { const m = parseT(t).mode; return m === "time" || m === "range"; };
function remArg(x: unknown): number[] | null {
  if (!Array.isArray(x)) return null;
  const r = [...new Set(x.map(Number).filter((v) => REMS.includes(v)))].sort((a, b) => b - a);
  return r.length ? r : null;
}
const dm = (hm: string) => { const [h, m] = hm.split(":").map(Number); const x = h * 60 + m; return x < 240 ? x + 1440 : x; };
const WORDM: Record<string, number> = { "πρωί": 480, "μεσημέρι": 780, "απόγευμα": 1020, "βράδυ": 1260 };
function ordM(t: string) { const p = parseT(t); if (p.mode === "empty") return null; if (p.mode === "label") return WORDM[p.label!] ?? null; return dm(p.a!); }
type W = { untimed: boolean; s: number; e: number; ve: number; in?: string };
function windows(list: Block[]) {
  const w: Record<string, W> = {};
  const raw: Record<string, { s: number; e: number | null }> = {};
  for (const b of list) {
    const p = parseT(b.t);
    if (p.mode === "label" || p.mode === "empty") { w[b.id] = { untimed: true, s: 0, e: 0, ve: 0 }; continue; }
    const s = dm(p.a!); let e: number | null = null;
    if (p.mode === "range") { e = dm(p.b!); if (e <= s) e += 1440; }
    raw[b.id] = { s, e };
  }
  const timed = list.filter((b) => raw[b.id]), nest = new Set(timed.filter((b) => b.nested).map((b) => b.id));
  const span = (x: { s: number; e: number | null }, starts: number[]) => {
    if (x.e != null) return { e: x.e, ve: x.e };
    const nx = starts.filter((v) => v > x.s), n = nx.length ? Math.min(...nx) : null;
    return n != null ? { e: Math.max(x.s + 30, n), ve: Math.max(x.s + 15, n) } : { e: x.s + 60, ve: x.s + 60 };
  };
  // Nested steps (b.nested) don't cut their host's window and belong to the step that
  // covers their start (w[id].in); one nobody covers is a normal step. Same as index.html.
  let sp: Record<string, { e: number; ve: number }>, host: Record<string, string>;
  for (;;) {
    const starts = timed.filter((b) => !nest.has(b.id)).map((b) => raw[b.id].s);
    sp = {}; for (const b of timed) sp[b.id] = span(raw[b.id], starts);
    host = {}; const out: string[] = [];
    nest.forEach((id) => { const x = raw[id], h = timed.find((o) => !nest.has(o.id) && raw[o.id].s <= x.s && x.s < sp[o.id].ve); if (h) host[id] = h.id; else out.push(id); });
    if (!out.length) break; out.forEach((id) => nest.delete(id));
  }
  for (const b of timed) {
    const x = raw[b.id], h = host[b.id], v = h && x.e == null ? { e: x.s + 30, ve: x.s + 30 } : sp[b.id];
    w[b.id] = { untimed: false, s: x.s, e: v.e, ve: v.ve, ...(h ? { in: h } : {}) };
  }
  return w;
}
const fmtM = (m: number) => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

// ---------- plan ----------
async function loadBlocks(uid: string): Promise<Block[]> {
  const { data, error } = await sb.from("tora_blocks").select("*").eq("user_id", uid);
  if (error) throw new Error(error.message);
  return (data ?? []) as Block[];
}
const tmpl = (all: Block[], wd: number) => all.filter((b) => !b.date && b.weekday === wd).sort((a, b) => a.pos - b.pos);
function planDay(all: Block[], dk: string) {
  const oo = all.filter((b) => b.date === dk).sort((a, b) => a.pos - b.pos);
  const hide = new Set(oo.map((b) => b.replaces).filter(Boolean));
  const tpl = tmpl(all, wdOf(dk)).filter((b) => !hide.has(b.id)); const out: Block[] = [];
  for (let i = 0; i <= tpl.length; i++) {
    for (const o of oo) if (Math.min(Math.max(0, Math.round(o.pos)), tpl.length) === i) out.push(o);
    if (i < tpl.length) out.push(tpl[i]);
  }
  return timeSort(out);
}
/** Same as index.html: timed steps in clock order, untimed ones keep their slot. */
function timeSort(list: Block[]) {
  const slots: number[] = [], items: { b: Block; m: number; i: number }[] = [];
  list.forEach((b, i) => { const m = ordM(b.t); if (m != null) { slots.push(i); items.push({ b, m, i }); } });
  items.sort((x, y) => x.m - y.m || x.i - y.i);
  const out = list.slice(); slots.forEach((k, j) => (out[k] = items[j].b)); return out;
}
function timeIndex(rows: Block[], t: string) { const m = ordM(t); if (m == null) return rows.length; const j = rows.findIndex((r) => { const x = ordM(r.t); return x != null && x > m; }); return j < 0 ? rows.length : j; }
/** Puts b (already in `all`) in time order and returns the rows whose pos changed. */
function placeByTime(all: Block[], b: Block): Block[] {
  if (b.date) { const tpl = planDay(all, b.date).filter((x) => !x.date && x.id !== b.id); b.pos = timeIndex(tpl, b.t); return [b]; }
  const rows = tmpl(all, b.weekday).filter((x) => x.id !== b.id); rows.splice(timeIndex(rows, b.t), 0, b);
  const changed: Block[] = []; rows.forEach((x, i) => { if (x.pos !== i || x === b) { x.pos = i; changed.push(x); } });
  return changed;
}
async function savePos(rows: Block[]) {
  for (const r of rows) { const { error } = await sb.from("tora_blocks").update({ pos: r.pos, updated_at: new Date().toISOString() }).eq("id", r.id).eq("user_id", r.user_id); if (error) throw new Error(error.message); }
}
function clashesOf(all: Block[], b: Block, dk: string) {
  const list = planDay(all, dk), w = windows(list), me = w[b.id];
  if (!me || me.untimed) return [] as Block[];
  return list.filter((x) => { if (x.id === b.id) return false; const v = w[x.id]; return !v.untimed && !v.in && me.s < v.e && v.s < me.e; });
}
function describe(b: Block) {
  return {
    id: b.id, title: b.n, time: b.t || null, tag: b.tag, notes: b.h || null,
    checklist: b.list?.length ? b.list.map((x) => x[0] + (x[1] ? ` (${x[1]})` : "")) : null,
    repeats: b.date ? "μία φορά" : "κάθε " + DAYS[b.weekday], date: b.date,
    deadline: b.deadline ? isoToAthens(b.deadline) : null, remind_min: b.remind_min, nested: !!b.nested,
  };
}
async function dayView(uid: string, dk: string, all?: Block[]) {
  all = all ?? await loadBlocks(uid);
  const full = planDay(all, dk), w = windows(full), list = full.filter((b) => !w[b.id].in);
  const { data: evs } = await sb.from("tora_events").select("*").eq("user_id", uid).eq("date", dk);
  const ev = (evs ?? []) as Ev[];
  const stOf = (b: Block) => ev.find((e) => e.block_id === b.id) ?? null;
  const st = list.map((b, i) => ev.find((e) => e.block_id === b.id) ?? ev.find((e) => !e.block_id && e.pos === i) ?? null);
  const cur = st.findIndex((e) => !e || e.status === "p");
  const S: Record<string, string> = { d: "έγινε", s: "παραλείφθηκε", p: "σε εξέλιξη" };
  return {
    date: dk, weekday: DAYS[wdOf(dk)], is_today: dk === todayKey(),
    steps: list.map((b, i) => ({
      ...describe(b), status: st[i] ? S[st[i]!.status] : "εκκρεμεί", started_at: st[i]?.started_at ? isoToAthens(st[i]!.started_at!) : null, current: i === cur && dk === todayKey(),
      // steps that happen inside this one: own ✓/skip, never the host's start
      inside: full.filter((x) => w[x.id].in === b.id).map((x) => ({ ...describe(x), status: stOf(x) ? S[stOf(x)!.status] : "εκκρεμεί" })),
    })),
  };
}

// ---------- MCP tools ----------
const TOOLS = [
  {
    name: "tora_today",
    description: "Το πρόγραμμα μιας μέρας στην Τώρα (σήμερα αν δεν δοθεί date): βήματα με σειρά, ώρα, κατάσταση (εκκρεμεί/σε εξέλιξη/έγινε/παραλείφθηκε) και ποιο είναι το τρέχον. Επιστρέφει και τη σημερινή ημερομηνία (Europe/Athens· η μέρα αλλάζει στις 04:00). Κάλεσέ το πρώτα για να μάθεις ids και ημερομηνίες.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD, 'today' ή 'tomorrow'" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "tora_week",
    description: "Οι επόμενες 7 μέρες (ή 7 μέρες από start) στην Τώρα: εβδομαδιαία βήματα + βήματα μίας φοράς, με ώρες και ids.",
    inputSchema: { type: "object", properties: { start: { type: "string", description: "YYYY-MM-DD (προεπιλογή: σήμερα)" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "tora_add_step",
    description: "Προσθέτει βήμα στην Τώρα, σε σειρά ώρας. Για μία φορά δώσε date· για κάθε εβδομάδα δώσε weekdays (ένα βήμα ανά μέρα). Επιστρέφει αν πέφτει πάνω σε άλλο βήμα (clashes)· τότε ρώτα τον χρήστη αν θέλει να το μετακινήσεις ή να σβήσεις το άλλο.",
    inputSchema: {
      type: "object", required: ["title"],
      properties: {
        title: { type: "string", description: "Σύντομος τίτλος, στα ελληνικά" },
        date: { type: "string", description: "Μία φορά: YYYY-MM-DD, 'today' ή 'tomorrow'" },
        weekdays: { type: "array", items: { type: ["integer", "string"] }, description: "Κάθε εβδομάδα: 0=Κυριακή … 6=Σάββατο, ή ονόματα (Δευτέρα, Tue…)" },
        time: { type: "string", description: "'18:40', '~18:40' (περίπου), '09:00–17:00' ή λέξη ('πρωί', 'βράδυ'). Κενό = χωρίς ώρα." },
        tag: { type: "string", enum: TAGS },
        notes: { type: "string", description: "Τι κάνει ακριβώς (προαιρετικό)" },
        deadline: { type: "string", description: "Προθεσμία, ώρα Ελλάδας: YYYY-MM-DDTHH:MM" },
        remind_min: { type: "array", items: { type: "integer", enum: [60, 30, 15, 5] }, description: "Λεπτά πριν (push): 60, 30, 15 ή 5. Με deadline μετράνε πριν την προθεσμία· χωρίς deadline, πριν την ώρα έναρξης του βήματος, κάθε μέρα που εμφανίζεται (π.χ. εβδομαδιαίο βήμα στις 08:50 με [5] → ειδοποίηση 08:45 κάθε μέρα). Θέλει ώρα (18:40 ή 09:00–17:00)." },
        nested: { type: "boolean", description: "true = γίνεται ΜΕΣΑ σε άλλο βήμα που καλύπτει την ώρα του (π.χ. φαγητό στη δουλειά): δεν μπαίνει στη σειρά και δεν διακόπτει το άλλο." },
      },
    },
  },
  {
    name: "tora_update_step",
    description: "Αλλάζει ένα βήμα (id από tora_today/tora_week). Δώσε μόνο ό,τι αλλάζει. Αλλαγή ώρας ή μέρας το ξαναβάζει σε σειρά ώρας.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: {
        id: { type: "string" }, title: { type: "string" }, time: { type: "string" }, tag: { type: "string", enum: TAGS },
        notes: { type: "string" }, date: { type: "string", description: "Για βήμα μίας φοράς: νέα ημερομηνία" },
        weekday: { type: ["integer", "string"], description: "Για εβδομαδιαίο βήμα: νέα μέρα" },
        deadline: { type: ["string", "null"], description: "YYYY-MM-DDTHH:MM ή null για αφαίρεση" },
        remind_min: { type: "array", items: { type: "integer", enum: [60, 30, 15, 5] }, description: "Λεπτά πριν την προθεσμία ή (χωρίς deadline) πριν την ώρα έναρξης. [] = καμία." },
        nested: { type: "boolean", description: "true/false: αν γίνεται μέσα σε άλλο βήμα που καλύπτει την ώρα του" },
      },
    },
  },
  {
    name: "tora_delete_step",
    description: "Σβήνει ένα βήμα (αν είναι εβδομαδιαίο, σβήνεται από κάθε εβδομάδα). Επιβεβαίωσε με τον χρήστη πριν.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    annotations: { destructiveHint: true },
  },
  {
    name: "tora_mark",
    description: "Σημειώνει βήμα σήμερα (ή date): done = ✓ Έγινε, skip = Παράλειψη, start = Ξεκίνα (χρονόμετρο), undo = αναίρεση. Χωρίς id → το τρέχον βήμα.",
    inputSchema: {
      type: "object", required: ["action"],
      properties: { action: { type: "string", enum: ["done", "skip", "start", "undo"] }, id: { type: "string" }, date: { type: "string" } },
    },
  },
];

async function callTool(name: string, a: Record<string, any>, uid: string): Promise<unknown> {
  if (name === "tora_today") return { today: todayKey(), now: isoToAthens(new Date().toISOString()), ...(await dayView(uid, dateArg(a.date))) };
  if (name === "tora_week") {
    const all = await loadBlocks(uid), start = dateArg(a.start), days = [];
    for (let i = 0; i < 7; i++) days.push(await dayView(uid, addDays(start, i), all));
    return { today: todayKey(), days };
  }
  if (name === "tora_add_step") {
    const title = String(a.title ?? "").trim(); if (!title) throw new Error("Λείπει ο τίτλος.");
    const t = normT(a.time), tag = TAGS.includes(a.tag) ? a.tag : "other";
    let dl: string | null = a.deadline ? athensToISO(a.deadline) : null;
    const rem = remArg(a.remind_min);
    if (rem && !dl && !hasClock(t)) throw new Error("Υπενθύμιση θέλει προθεσμία (deadline) ή ώρα έναρξης (π.χ. 08:50). Χωρίς κανένα από τα δύο δεν έχει από πού να μετρήσει.");
    if (a.date && a.weekdays?.length) throw new Error("Δώσε ή date (μία φορά) ή weekdays (κάθε εβδομάδα), όχι και τα δύο.");
    const targets: { date: string | null; wd: number }[] = a.weekdays?.length
      ? [...new Set((a.weekdays as unknown[]).map(weekdayArg))].map((wd) => ({ date: null, wd }))
      : [{ date: dateArg(a.date), wd: wdOf(dateArg(a.date)) }];
    const all = await loadBlocks(uid), made = [];
    for (const tg of targets) {
      const b: Block = { id: crypto.randomUUID(), user_id: uid, weekday: tg.wd, pos: 0, t, n: title, h: String(a.notes ?? ""), list: null, tag, date: tg.date, deadline: dl, remind_min: rem, replaces: null, nested: a.nested === true };
      all.push(b); const moved = placeByTime(all, b);
      const { error } = await sb.from("tora_blocks").insert(b); if (error) throw new Error(error.message);
      await savePos(moved.filter((x) => x !== b));
      const dk = tg.date ?? (() => { let d = todayKey(); while (wdOf(d) !== tg.wd) d = addDays(d, 1); return d; })();
      made.push({ ...describe(b), clashes: clashesOf(all, b, dk).map((x) => ({ id: x.id, title: x.n, time: x.t })) });
    }
    return { added: made };
  }
  if (name === "tora_update_step") {
    const all = await loadBlocks(uid), b = all.find((x) => x.id === a.id); if (!b) throw new Error("Δεν βρέθηκε βήμα με αυτό το id.");
    const patch: Partial<Block> = {}; let replace = false;
    if (a.title != null) patch.n = String(a.title).trim() || b.n;
    if (a.time != null) { patch.t = normT(a.time); replace = true; }
    if (a.tag != null && TAGS.includes(a.tag)) patch.tag = a.tag;
    if (a.notes != null) patch.h = String(a.notes);
    if (a.nested != null) { patch.nested = a.nested === true; replace = true; }
    if (a.date != null) { if (!b.date) throw new Error("Είναι εβδομαδιαίο βήμα· άλλαξε weekday, όχι date."); patch.date = dateArg(a.date); patch.weekday = wdOf(patch.date); patch.replaces = null; replace = true; }
    if (a.weekday != null) { if (b.date) throw new Error("Είναι βήμα μίας φοράς· άλλαξε date."); patch.weekday = weekdayArg(a.weekday); replace = true; }
    if (a.deadline !== undefined) patch.deadline = a.deadline ? athensToISO(a.deadline) : null;
    if (a.remind_min !== undefined) patch.remind_min = remArg(a.remind_min);
    // Removing the deadline drops its reminders (as before) unless new ones are given. Other edits never touch remind_min.
    if (a.deadline !== undefined && !a.deadline && patch.remind_min === undefined) patch.remind_min = null;
    const after = { deadline: patch.deadline !== undefined ? patch.deadline : b.deadline, t: patch.t !== undefined ? patch.t : b.t, rem: patch.remind_min !== undefined ? patch.remind_min : b.remind_min };
    if (a.remind_min !== undefined && after.rem && !after.deadline && !hasClock(after.t)) throw new Error("Υπενθύμιση θέλει προθεσμία (deadline) ή ώρα έναρξης (π.χ. 08:50).");
    Object.assign(b, patch);
    const moved = replace ? placeByTime(all, b) : [];
    const { error } = await sb.from("tora_blocks").update({ ...patch, pos: b.pos, updated_at: new Date().toISOString() }).eq("id", b.id).eq("user_id", uid);
    if (error) throw new Error(error.message);
    await savePos(moved.filter((x) => x !== b));
    return { updated: describe(b) };
  }
  if (name === "tora_delete_step") {
    const { data, error } = await sb.from("tora_blocks").delete().eq("id", a.id).eq("user_id", uid).select("n");
    if (error) throw new Error(error.message); if (!data?.length) throw new Error("Δεν βρέθηκε βήμα με αυτό το id.");
    return { deleted: data[0].n };
  }
  if (name === "tora_mark") {
    const dk = dateArg(a.date), all = await loadBlocks(uid), full = planDay(all, dk), w = windows(full);
    // a nested step is marked by its id; it is not part of the main sequence
    const list = full.filter((b) => !w[b.id].in || b.id === a.id);
    const { data: evs } = await sb.from("tora_events").select("*").eq("user_id", uid).eq("date", dk);
    const ev = (evs ?? []) as Ev[];
    const st = list.map((b, i) => ev.find((e) => e.block_id === b.id) ?? ev.find((e) => !e.block_id && e.pos === i) ?? null);
    const now = new Date().toISOString();
    if (a.action === "undo") {
      const done = ev.filter((e) => e.status !== "p"); if (!done.length) throw new Error("Δεν υπάρχει κάτι για αναίρεση.");
      const last = a.id ? done.find((e) => e.block_id === a.id) : done.reduce((m, x) => (x.at > m.at ? x : m));
      if (!last) throw new Error("Αυτό το βήμα δεν έχει σημειωθεί.");
      if (last.started_at) await sb.from("tora_events").update({ status: "p" }).eq("id", last.id!).eq("user_id", uid);
      else await sb.from("tora_events").delete().eq("id", last.id!).eq("user_id", uid);
      return { undone: last.name, now_status: last.started_at ? "σε εξέλιξη" : "εκκρεμεί" };
    }
    const i = a.id ? list.findIndex((b) => b.id === a.id) : st.findIndex((e) => !e || e.status === "p");
    if (i < 0) throw new Error(a.id ? "Το βήμα δεν είναι σε αυτή τη μέρα." : "Όλα τα βήματα της μέρας έχουν σημειωθεί.");
    const b = list[i], prev = st[i], status = { done: "d", skip: "s", start: "p" }[a.action as "done" | "skip" | "start"];
    if (!status) throw new Error("action: done | skip | start | undo");
    if (prev && prev.status !== "p" && a.action === "start") throw new Error("Το βήμα έχει ήδη σημειωθεί.");
    const used = ev.map((e) => e.pos);
    const row: Ev = prev
      ? { ...prev, status, at: now, started_at: status === "p" ? now : prev.started_at }
      : { user_id: uid, date: dk, pos: used.includes(i) ? Math.max(100, ...used) + 1 : i, block_id: b.id, name: b.n, tag: b.tag, status, at: now, started_at: status === "p" ? now : null };
    const { error } = await sb.from("tora_events").upsert(row, { onConflict: "user_id,date,pos" }); if (error) throw new Error(error.message);
    const next = list.slice(i + 1).find((_, k) => !st[i + 1 + k]);
    return { marked: b.n, status: { d: "έγινε", s: "παραλείφθηκε", p: "σε εξέλιξη" }[status], next: next ? { id: next.id, title: next.n, time: next.t || null } : null };
  }
  throw new Error(`Άγνωστο εργαλείο: ${name}`);
}

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
// serverInfo.icons (MCP 2025-11-25). claude.ai currently shows the URL domain's favicon instead; kept so the logo appears once clients read it.
const ICONS = [{ src: "https://costgal.github.io/tora/icon-192.png", mimeType: "image/png", sizes: ["192x192"] }, { src: "https://costgal.github.io/tora/icon-512.png", mimeType: "image/png", sizes: ["512x512"] }];
async function mcp(req: Request, uid: string) {
  if (req.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  let msg: any;
  try { msg = await req.json(); } catch { return rpcJson({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const batch = Array.isArray(msg) ? msg : [msg], out = [];
  for (const m of batch) {
    if (m?.id === undefined || m?.id === null) continue; // notification
    out.push(await handle(m, uid));
  }
  if (!out.length) return new Response(null, { status: 202 });
  return rpcJson(Array.isArray(msg) ? out : out[0]);
}
async function handle(m: any, uid: string) {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": {
      const v = VERSIONS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : VERSIONS[0];
      return ok({
        protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "tora", title: "Τώρα", version: "1.1.0", icons: ICONS, websiteUrl: "https://costgal.github.io/tora/" },
        instructions: "Τώρα: το καθημερινό πρόγραμμα του Κώστα (βήματα με ώρα, εβδομαδιαία ή μίας φοράς). Ξεκίνα με tora_today για ημερομηνία και ids. Ώρες σε Europe/Athens. Γράφε τίτλους στα ελληνικά, σύντομους.",
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      try {
        const r = await callTool(m.params?.name, m.params?.arguments ?? {}, uid);
        return ok({ content: [{ type: "text", text: JSON.stringify(r, null, 1) }], structuredContent: r });
      } catch (e) {
        return ok({ content: [{ type: "text", text: "Σφάλμα: " + (e as Error).message }], isError: true });
      }
    }
    default: return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}
const rpcJson = (b: unknown) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });

// ---------- iCalendar feed ----------
const icsEsc = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line: string) {
  const enc = new TextEncoder(), out: string[] = []; let cur = "", n = 0;
  for (const ch of line) { const l = enc.encode(ch).length; if (n + l > (out.length ? 74 : 75)) { out.push(cur); cur = ""; n = 0; } cur += ch; n += l; }
  out.push(cur); return out.join("\r\n ");
}
const icsDate = (dk: string) => dk.replace(/-/g, "");
const icsLocal = (dk: string, m: number) => { const d = m >= 1440 ? addDays(dk, 1) : dk; m %= 1440; return `${icsDate(d)}T${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}00`; };
const icsUTC = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+/, "");
function descr(b: Block) {
  const p = parseT(b.t), lines = [];
  if (p.approx) lines.push("Περίπου " + p.a);
  if (b.h) lines.push(b.h);
  if (b.list?.length) lines.push(b.list.map((x) => "• " + x[0] + (x[1] ? " " + x[1] : "")).join("\n"));
  if (b.deadline) lines.push("Προθεσμία: " + isoToAthens(b.deadline));
  return lines.join("\n\n");
}
const VTZ = ["BEGIN:VTIMEZONE", "TZID:Europe/Athens", "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0300", "TZNAME:EEST", "DTSTART:19700329T030000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT", "BEGIN:STANDARD", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0200", "TZNAME:EET", "DTSTART:19701025T040000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE"];
async function ics(uid: string) {
  const all = await loadBlocks(uid), stamp = icsUTC(new Date().toISOString()), td = todayKey();
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//costgal//Tora//EL", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Τώρα", "X-WR-TIMEZONE:Europe/Athens", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H", ...VTZ];
  const ev = (uidStr: string, summary: string, when: string[], extra: string[] = [], desc = "") => {
    L.push("BEGIN:VEVENT", `UID:${uidStr}@tora.costgal`, `DTSTAMP:${stamp}`, ...when, `SUMMARY:${icsEsc(summary)}`, ...(desc ? [`DESCRIPTION:${icsEsc(desc)}`] : []), ...extra, "END:VEVENT");
  };
  const timed = (dk: string, s: number, e: number) => [`DTSTART;TZID=${TZ}:${icsLocal(dk, s)}`, `DTEND;TZID=${TZ}:${icsLocal(dk, e)}`];
  const allDay = (dk: string) => [`DTSTART;VALUE=DATE:${icsDate(dk)}`, `DTEND;VALUE=DATE:${icsDate(addDays(dk, 1))}`];
  // weekly template: one recurring event per row, starting 4 weeks back
  for (let wd = 0; wd < 7; wd++) {
    const rows = tmpl(all, wd); if (!rows.length) continue;
    const w = windows(rows); let first = addDays(td, -28); while (wdOf(first) !== wd) first = addDays(first, 1);
    for (const b of rows) {
      const v = w[b.id], ex = all.filter((o) => o.replaces === b.id && o.date).map((o) => o.date!);
      const rr = [`RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[wd]}`];
      if (v.untimed) { if (ex.length) rr.push(`EXDATE;VALUE=DATE:${ex.map(icsDate).join(",")}`); ev(b.id, b.t ? `${b.n} · ${b.t}` : b.n, allDay(first), rr, descr(b)); }
      else { if (ex.length) rr.push(`EXDATE;TZID=${TZ}:${ex.map((d) => icsLocal(d, v.s)).join(",")}`); ev(b.id, b.n, timed(first, v.s, v.ve), rr, descr(b)); }
    }
  }
  // one-offs from 4 weeks back on
  const from = addDays(td, -28);
  for (const b of all.filter((x) => x.date && x.date >= from)) {
    const v = windows(planDay(all, b.date!))[b.id];
    if (!v || v.untimed) ev(b.id, b.t ? `${b.n} · ${b.t}` : b.n, allDay(b.date!), [], descr(b));
    else ev(b.id, b.n, timed(b.date!, v.s, v.ve), [], descr(b));
  }
  // deadlines as their own short events
  for (const b of all.filter((x) => x.deadline && x.deadline >= new Date(Date.now() - 28 * 864e5).toISOString())) {
    const s = icsUTC(new Date(b.deadline!).toISOString()), e = icsUTC(new Date(new Date(b.deadline!).getTime() + 15 * 60000).toISOString());
    ev(b.id + "-dl", "⏰ Προθεσμία: " + b.n, [`DTSTART:${s}`, `DTEND:${e}`]);
  }
  L.push("END:VCALENDAR");
  return new Response(L.map(fold).join("\r\n") + "\r\n", { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache" } });
}

// ---------- routing ----------
Deno.serve(async (req) => {
  const m = new URL(req.url).pathname.match(/\/(ics|mcp)\/([a-f0-9]{32,64})(?:\.ics)?\/?$/);
  if (!m) return new Response("Not found", { status: 404 });
  const { data } = await sb.from("tora_tokens").select("user_id").eq("token", m[2]).eq("kind", m[1]).maybeSingle();
  if (!data) return new Response("Forbidden", { status: 403 });
  try {
    return m[1] === "ics" ? await ics(data.user_id) : await mcp(req, data.user_id);
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
