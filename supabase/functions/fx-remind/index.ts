// VCASO Fitness morning call. pg_cron hits this every 5 minutes (header x-cron).
// At each driver's morning time (their own time zone, so it follows them to race weekends):
// pull last night from Oura, then push today's session, the readiness call, and on Mondays last week's score.
// A signed-in driver can POST {test:true} to get a test notification.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = Deno.env.get("FX_SITE") || "https://riki-vcaso.github.io/vcaso-fitness/";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

let cfg: Record<string, string> | null = null;
async function config() {
  if (cfg) return cfg;
  const { data, error } = await sb.from("rh_config").select("key,value");
  if (error || !data?.length) throw new Error("config unavailable");
  const c = Object.fromEntries(data.map((r: any) => [r.key, r.value]));
  webpush.setVapidDetails("mailto:riki@rikichristo.com", c.vapid_public, c.vapid_private);
  return (cfg = c);
}
async function pushUser(userId: string, msg: { title: string; body: string; url: string; tag?: string }) {
  const { data: subs } = await sb.from("fx_push_subs").select("id,sub").eq("user_id", userId);
  let sent = 0;
  for (const s of subs || []) {
    try { await webpush.sendNotification(s.sub, JSON.stringify(msg), { TTL: 4 * 3600, urgency: "high" }); sent++; }
    catch (e: any) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await sb.from("fx_push_subs").delete().eq("id", s.id); else console.warn("push failed", e?.statusCode, e?.body); }
  }
  return sent;
}
async function once(tag: string) { const { error } = await sb.from("fx_push_log").insert({ tag }); return !error; }

function local(tz: string) {
  let p: Record<string, string>;
  try { p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value])); }
  catch { return local("Europe/London"); }
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute, wd: p.weekday };
}
const toMin = (t: string) => { const m = String(t || "").match(/(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : 420; };
const mondayOf = (d: string) => { const x = new Date(d + "T12:00:00Z"); const k = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - k); return x.toISOString().slice(0, 10); };
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function syncFirst(user: string, secret: string) {
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/fx-sync`, { method: "POST", headers: { "Content-Type": "application/json", "x-cron": secret, Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}` }, body: JSON.stringify({ action: "sync_user", user }) });
  } catch (e) { console.warn("sync", e); }
}

async function morning(user: any, date: string, wd: string, secret: string) {
  await syncFirst(user.user_id, secret);
  const [{ data: day }, { data: oura }] = await Promise.all([
    sb.from("fx_day").select("data,plan_title").eq("user_id", user.user_id).eq("date", date).maybeSingle(),
    sb.from("fx_oura").select("*").eq("user_id", user.user_id).eq("date", date).maybeSingle(),
  ]);
  const p = user.data || {}, name = p.name || "Driver";
  let title = day?.plan_title || "Today's session";
  const bits: string[] = [];
  let red = false, amber = false;
  if (oura) {
    if (oura.readiness != null && oura.readiness < 55 || oura.sleep_score != null && oura.sleep_score < 55 || oura.temp_dev != null && oura.temp_dev >= 0.5) red = true;
    else if (oura.readiness != null && oura.readiness < 70 || oura.sleep_score != null && oura.sleep_score < 70) amber = true;
    bits.push(`Readiness ${oura.readiness ?? "—"}, sleep ${oura.sleep_score ?? "—"}${oura.temp_dev >= 0.3 ? `, temp +${(+oura.temp_dev).toFixed(1)}` : ""}.`);
  }
  if (title === "Moved to tomorrow") { title = "Session moved"; bits.push("Check in, log your food, hit your water. Tomorrow is non-negotiable."); }
  else if (red) { title = "Red flag · recovery day"; bits.push("No cardio today. Open the app, check in, do the recovery protocol. It counts."); }
  else if (amber) bits.push(`${title}, trimmed for today. Check in first, then go to work.`);
  else bits.push(`${title}. ${oura ? "Green light. " : ""}Check in, then go to work, ${name}.`);
  if (wd === "Mon") {
    const lastMon = addDays(mondayOf(date), -7);
    const sc = p.scores && p.scores[lastMon];
    if (sc != null) bits.push(`Last week: ${sc}/100. ${sc >= 90 ? "Podium. Same again." : sc >= 80 ? "Points. Find the last 10%." : sc >= 65 ? "Midfield. Not good enough." : "That week cost you. Reset today."}`);
  }
  return pushUser(user.user_id, { title: `${name} · ${title}`, body: bits.join(" "), url: SITE, tag: "fx-morning" });
}

async function run(dry: boolean) {
  const c = await config(); const log: string[] = [];
  const { data: users } = await sb.from("fx_profile").select("user_id,data,notify_wd,notify_we,notify_on,tz").eq("notify_on", true);
  for (const u of users || []) {
    const L = local(u.tz || "Europe/London");
    const weekend = L.wd === "Sat" || L.wd === "Sun";
    const at = toMin(weekend ? u.notify_we : u.notify_wd);
    if (L.min < at || L.min >= at + 15) continue;            // 15-minute window survives a skipped cron tick
    const tag = `m|${u.user_id}|${L.date}`;
    if (dry) { log.push("would send " + tag); continue; }
    if (!(await once(tag))) continue;
    const n = await morning(u, L.date, L.wd, c.cron_secret);
    log.push(`sent ${tag} → ${n}`);
  }
  // keep wearable data fresh during the day too: once an hour
  const m = new Date().getUTCMinutes();
  if (!dry && m < 5) { EdgeRuntime.waitUntil(fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/fx-sync`, { method: "POST", headers: { "Content-Type": "application/json", "x-cron": c.cron_secret, Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}` }, body: JSON.stringify({ action: "sync_all" }) }).catch(() => {})); log.push("hourly sync"); }
  return { log };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const c = await config();
  const body = await req.json().catch(() => ({}));
  if (req.headers.get("x-cron") === c.cron_secret) return json(await run(!!body.dry));
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await sb.auth.getUser(jwt);
  if (!u?.user) return json({ error: "not signed in" }, 401);
  if (body.test) {
    const n = await pushUser(u.user.id, { title: "VCASO Fitness · morning call is on", body: "Every morning: today's session, your readiness, and on Mondays your score. No excuses.", url: SITE, tag: "fx-test" });
    return json({ sent: n });
  }
  return json({ ok: true });
});
