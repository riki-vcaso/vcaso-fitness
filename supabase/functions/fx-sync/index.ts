// VCASO Fitness wearables: Oura (sleep, readiness) and Garmin via Strava (activities).
// POST {action:"auth", provider, ret}   signed-in user → returns the provider's consent URL
// GET  /fx-sync/oura|strava?code&state      provider redirects here → tokens saved → back to the app
// POST {action:"sync"}                  signed-in user → pull the last 30 days
// POST {action:"unlink", provider}      signed-in user → forget the tokens
// POST {action:"sync_user"|"sync_all"}  with x-cron → used by the morning call
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/fx-sync`;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";

const P: Record<string, { auth: string; token: string; id: string; secret: string; scope: string }> = {
  oura: { auth: "https://cloud.ouraring.com/oauth/authorize", token: "https://api.ouraring.com/oauth/token", id: "OURA_CLIENT_ID", secret: "OURA_CLIENT_SECRET", scope: "personal daily heartrate workout" },
  strava: { auth: "https://www.strava.com/oauth/authorize", token: "https://www.strava.com/oauth/token", id: "STRAVA_CLIENT_ID", secret: "STRAVA_CLIENT_SECRET", scope: "read,activity:read_all" },
};

let secret: string | null = null;
async function cronSecret() {
  if (secret) return secret;
  const { data } = await sb.from("rh_config").select("value").eq("key", "cron_secret").single();
  return (secret = data?.value || "");
}
// signed OAuth state, so a callback can't be forged for someone else's account
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(s: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(await cronSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(s))));
}
async function sign(o: unknown) { const p = b64u(new TextEncoder().encode(JSON.stringify(o))); return `${p}.${await hmac(p)}`; }
async function verify(s: string) {
  const [p, sig] = (s || "").split("."); if (!p || sig !== await hmac(p)) return null;
  const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))));
  return o.exp > Date.now() ? o : null;
}

async function exchange(provider: string, body: Record<string, string>) {
  const c = P[provider];
  const r = await fetch(c.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env(c.id), client_secret: env(c.secret), ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`${provider} token: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
async function saveTokens(user_id: string, provider: string, j: any) {
  const expires_at = j.expires_at ? new Date(j.expires_at * 1000).toISOString() : new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString();
  const { error } = await sb.from("fx_tokens").upsert({ user_id, provider, access: j.access_token, refresh: j.refresh_token, expires_at, ext_user: j.athlete?.id ? String(j.athlete.id) : null, updated_at: new Date().toISOString() });
  if (error) throw error;
}
async function token(user_id: string, provider: string) {
  const { data: t } = await sb.from("fx_tokens").select("*").eq("user_id", user_id).eq("provider", provider).maybeSingle();
  if (!t) return null;
  if (new Date(t.expires_at).getTime() - Date.now() > 120_000) return t.access as string;
  const j = await exchange(provider, { grant_type: "refresh_token", refresh_token: t.refresh });
  if (!j.refresh_token) j.refresh_token = t.refresh;
  await saveTokens(user_id, provider, j);
  return j.access_token as string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
async function syncOura(user_id: string, days = 30) {
  const at = await token(user_id, "oura"); if (!at) return null;
  const end = iso(new Date(Date.now() + 864e5)), start = iso(new Date(Date.now() - days * 864e5));
  const get = async (path: string) => {
    const r = await fetch(`https://api.ouraring.com/v2/usercollection/${path}?start_date=${start}&end_date=${end}`, { headers: { Authorization: `Bearer ${at}` } });
    if (!r.ok) { console.warn("oura", path, r.status, await r.text()); return []; }
    return (await r.json()).data || [];
  };
  const [rd, ds, sl, ac] = await Promise.all([get("daily_readiness"), get("daily_sleep"), get("sleep"), get("daily_activity")]);
  const rows: Record<string, any> = {};
  const row = (day: string) => (rows[day] ||= { user_id, date: day, updated_at: new Date().toISOString() });
  for (const x of rd) { const r = row(x.day); r.readiness = x.score; r.temp_dev = x.temperature_deviation; }
  for (const x of ds) row(x.day).sleep_score = x.score;
  // the main night: longest long_sleep period for the day
  const best: Record<string, any> = {};
  for (const x of sl) { if (x.type && x.type !== "long_sleep" && x.type !== "sleep") continue; if (!best[x.day] || (x.total_sleep_duration || 0) > (best[x.day].total_sleep_duration || 0)) best[x.day] = x; }
  for (const [day, x] of Object.entries(best)) { const r = row(day); r.sleep_s = x.total_sleep_duration; r.hrv = x.average_hrv; r.rhr = x.lowest_heart_rate; }
  for (const x of ac) row(x.day).steps = x.steps;
  const list = Object.values(rows);
  if (list.length) { const { error } = await sb.from("fx_oura").upsert(list); if (error) throw error; }
  return list.length;
}
async function syncStrava(user_id: string, days = 45) {
  const at = await token(user_id, "strava"); if (!at) return null;
  const after = Math.floor((Date.now() - days * 864e5) / 1000);
  const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`, { headers: { Authorization: `Bearer ${at}` } });
  if (!r.ok) throw new Error(`strava activities: ${r.status} ${(await r.text()).slice(0, 160)}`);
  const acts = await r.json();
  const rows = acts.map((a: any) => ({ user_id, source: "strava", ext_id: String(a.id), date: String(a.start_date_local).slice(0, 10), start_at: a.start_date, sport: a.sport_type || a.type, name: a.name,
    dur_s: a.moving_time ?? a.elapsed_time, dist_m: a.distance, avg_hr: a.average_heartrate ?? null, max_hr: a.max_heartrate ?? null, kj: a.kilojoules ?? null }));
  if (rows.length) { const { error } = await sb.from("fx_activity").upsert(rows); if (error) throw error; }
  return rows.length;
}
async function syncUser(user_id: string) {
  const out: Record<string, unknown> = {};
  try { out.oura = await syncOura(user_id); } catch (e) { console.warn(e); out.oura_error = String((e as Error).message || e); }
  try { out.strava = await syncStrava(user_id); } catch (e) { console.warn(e); out.strava_error = String((e as Error).message || e); }
  return out;
}

const back = (ret: string, q: string) => Response.redirect(`${ret.split("#")[0]}#/rec?${q}`, 302);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  // provider redirect back
  const cb = url.pathname.split("/").filter(Boolean).pop() || "";
  if (req.method === "GET" && cb && P[cb]) {
    const st = await verify(url.searchParams.get("state") || "");
    if (!st || st.p !== cb) return new Response("This link has expired. Go back to VCASO Fitness and tap Connect again.", { status: 400 });
    const err = url.searchParams.get("error");
    if (err) return back(st.ret, `link_error=${encodeURIComponent(err)}`);
    try {
      const j = await exchange(cb, { grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: `${SELF}/${cb}` });
      await saveTokens(st.u, cb, j);
      // first pull so the app has data the moment it opens
      try { cb === "oura" ? await syncOura(st.u, 60) : await syncStrava(st.u, 60); } catch (e) { console.warn(e); }
      return back(st.ret, `linked=${cb}`);
    } catch (e) { console.warn(e); return back(st.ret, `link_error=${encodeURIComponent(String((e as Error).message).slice(0, 80))}`); }
  }

  const body = await req.json().catch(() => ({}));
  if (req.headers.get("x-cron") && req.headers.get("x-cron") === await cronSecret()) {
    if (body.action === "sync_user" && body.user) return json(await syncUser(body.user));
    if (body.action === "sync_all") {
      const { data } = await sb.from("fx_tokens").select("user_id");
      const users = [...new Set((data || []).map((r: any) => r.user_id))];
      const out: Record<string, unknown> = {};
      for (const u of users) out[u as string] = await syncUser(u as string);
      return json(out);
    }
    return json({ error: "unknown cron action" }, 400);
  }

  // everything else: a signed-in driver, checked here (the gateway accepts the publishable key)
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await sb.auth.getUser(jwt);
  if (!u?.user) return json({ error: "not signed in" }, 401);
  const uid = u.user.id;

  if (body.action === "auth") {
    const c = P[body.provider]; if (!c) return json({ error: "unknown provider" }, 400);
    if (!env(c.id) || !env(c.secret)) return json({ error: `${body.provider} is not configured yet (client id missing)` }, 503);
    const ret = String(body.ret || "");
    // only back to a GitHub Pages site or a local dev server: never an arbitrary host
    if (!/^https:\/\/[a-z0-9-]+\.github\.io(\/|$)/i.test(ret) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(ret)) return json({ error: "bad return address" }, 400);
    const state = await sign({ u: uid, p: body.provider, ret, exp: Date.now() + 15 * 60e3 });
    const q = new URLSearchParams({ client_id: env(c.id), response_type: "code", redirect_uri: `${SELF}/${body.provider}`, scope: c.scope, state });
    if (body.provider === "strava") q.set("approval_prompt", "auto");
    return json({ url: `${c.auth}?${q}` });
  }
  if (body.action === "sync") return json(await syncUser(uid));
  if (body.action === "unlink") { await sb.from("fx_tokens").delete().eq("user_id", uid).eq("provider", body.provider); return json({ ok: true }); }
  return json({ ok: true });
});
