/* VCASO Fitness · the app.
   Local-first: everything is saved on the device straight away, then synced to the VCASO account when there's signal.
   If the network or the login script is unavailable, it runs on a local profile instead of failing to start. */
"use strict";
const CFG = window.FX_CONFIG || {};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const { pad, addDays, dow, monday, diffDays, todayISO } = FX;
const fmtDay = (s, o = { weekday: "short", day: "numeric", month: "short" }) => s ? FX.parse(s).toLocaleDateString("en-GB", o) : "";
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + " min" : ""}`.trim() : `${m} min`;
const mmss = s => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
const r1 = n => Math.round(n * 10) / 10;
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem("fx:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { v == null ? localStorage.removeItem("fx:" + k) : localStorage.setItem("fx:" + k, JSON.stringify(v)); } catch (e) {} },
};

/* ---------- Supabase (optional) ---------- */
let sb = null;
try { if (window.supabase && CFG.url) sb = supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } }); } catch (e) { sb = null; }

/* ---------- state ---------- */
const S = {
  user: null,
  mode: ls.get("mode"),                 // "cloud" | "local" | null (not chosen yet)
  profile: ls.get("profile", null),
  days: ls.get("days", {}),
  acts: ls.get("acts", []),
  oura: ls.get("oura", {}),
  bt: ls.get("bt", {}),
  links: ls.get("links", {}),
  dirty: ls.get("dirty", { days: [], profile: false }),
  route: [], ob: {}, sheet: null, player: null,
};
const P = () => {
  const p = S.profile || {};
  const rh = Object.entries(S.oura).filter(([d, o]) => o.rhr && d < todayISO() && diffDays(d, todayISO()) <= 30).map(([, o]) => +o.rhr).sort((a, b) => a - b);
  return { ...p, rhrBase: rh.length >= 5 ? rh[Math.floor(rh.length / 2)] : null };
};
const D = date => (S.days[date] = S.days[date] || {});
const actsOn = date => S.acts.filter(a => a.date === date);
const lastWeight = () => { const ds = Object.keys(S.days).filter(d => S.days[d].w).sort(); return ds.length ? S.days[ds[ds.length - 1]].w : (S.profile && S.profile.weight); };

function sessionOn(date) {
  const p = P(), s0 = FX.planFor(date, p), day = S.days[date] || {};
  const rd = FX.readiness(S.oura[date], day.ci, p.rhrBase);
  const s = FX.adapt(s0, rd, day.override);
  const v = FX.verify(s, actsOn(date));
  return { s, s0, rd, v, day, st: day.s && day.s.status };
}
const ctx = () => ({ profile: P(), today: todayISO(), day: d => S.days[d], acts: actsOn, oura: d => S.oura[d], bt: d => S.bt[d], lastWeight: lastWeight() });

/* ---------- saving + sync ---------- */
let syncTimer = null;
function touch(date) {
  if (date) { D(date)._t = Date.now(); if (!S.dirty.days.includes(date)) S.dirty.days.push(date); }
  else { S.profile._t = Date.now(); S.dirty.profile = true; }
  ls.set("days", S.days); ls.set("profile", S.profile); ls.set("dirty", S.dirty);
  clearTimeout(syncTimer); syncTimer = setTimeout(flush, 800);
}
function setSync(t, cls) { const el = $("#sync"); if (!el) return; el.className = "sync " + (cls || ""); el.querySelector("span").textContent = t; }
async function flush() {
  if (!sb || !S.user || !navigator.onLine) { if (S.user) setSync("Saved on phone", ""); return; }
  const uid = S.user.id;
  try {
    if (S.dirty.profile && S.profile) {
      const p = S.profile;
      const { error } = await sb.from("fx_profile").upsert({ user_id: uid, data: p, notify_wd: p.notifyWd || "07:00", notify_we: p.notifyWe || "08:30", notify_on: p.notifyOn !== false, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London", updated_at: new Date().toISOString() });
      if (error) throw error;
      S.dirty.profile = false;
    }
    const dates = [...S.dirty.days];
    if (dates.length) {
      const rows = dates.map(d => ({ user_id: uid, date: d, data: S.days[d] || {}, plan_title: titleFor(d), updated_at: new Date().toISOString() }));
      const { error } = await sb.from("fx_day").upsert(rows);
      if (error) throw error;
      S.dirty.days = S.dirty.days.filter(d => !dates.includes(d));
    }
    ls.set("dirty", S.dirty); setSync("Synced", "ok");
  } catch (e) { console.warn(e); setSync("Saved on phone", "bad"); }
}
const titleFor = d => { try { return sessionOn(d).s.title; } catch (e) { return null; } };
// the morning alert names the session, so write the next 7 days' titles
async function pushTitles() {
  if (!sb || !S.user || !S.profile) return;
  const rows = []; for (let i = 0; i < 8; i++) { const d = addDays(todayISO(), i); if (!S.days[d]) rows.push({ user_id: S.user.id, date: d, data: {}, plan_title: titleFor(d) }); }
  for (const r of rows) await sb.from("fx_day").upsert(r, { onConflict: "user_id,date", ignoreDuplicates: true });
  const known = Object.keys(S.days).filter(d => d >= todayISO() && d <= addDays(todayISO(), 7));
  for (const d of known) await sb.from("fx_day").update({ plan_title: titleFor(d) }).eq("user_id", S.user.id).eq("date", d);
}

async function loadCloud() {
  const uid = S.user.id, since = addDays(todayISO(), -180);
  const [pr, dy, ac, ou, lk] = await Promise.all([
    sb.from("fx_profile").select("*").eq("user_id", uid).maybeSingle(),
    sb.from("fx_day").select("date,data,updated_at").eq("user_id", uid).gte("date", since),
    sb.from("fx_activity").select("*").eq("user_id", uid).gte("date", since).order("start_at", { ascending: false }),
    sb.from("fx_oura").select("*").eq("user_id", uid).gte("date", since),
    sb.rpc("fx_links"),
  ]);
  for (const r of [pr, dy, ac, ou]) if (r.error) throw r.error;
  if (pr.data && pr.data.data && Object.keys(pr.data.data).length) {
    const cloud = pr.data.data;
    if (!S.profile || !S.dirty.profile || (cloud._t || 0) > (S.profile._t || 0)) S.profile = cloud;
  } else if (S.profile) S.dirty.profile = true;     // local profile → push it up
  for (const r of dy.data || []) {
    const local = S.days[r.date];
    if (!local || !S.dirty.days.includes(r.date) || (r.data._t || 0) > (local._t || 0)) { if (r.data && Object.keys(r.data).length) S.days[r.date] = r.data; }
  }
  S.acts = (ac.data || []).map(a => ({ ...a, date: String(a.date).slice(0, 10) }));
  S.oura = Object.fromEntries((ou.data || []).map(o => [String(o.date).slice(0, 10), o]));
  S.links = Object.fromEntries(((lk && lk.data) || []).map(l => [l.provider, l.linked_at]));
  try { const bt = await sb.rpc("fx_bt_runs", { since: addDays(todayISO(), -90) }); if (!bt.error) S.bt = Object.fromEntries((bt.data || []).map(b => [String(b.day).slice(0, 10), +b.runs])); } catch (e) {}
  ["days", "acts", "oura", "bt", "links", "profile"].forEach(k => ls.set(k, S[k]));
  // any local-only days go up too
  for (const d of Object.keys(S.days)) if (!(dy.data || []).some(r => r.date === d) && Object.keys(S.days[d]).length && !S.dirty.days.includes(d)) S.dirty.days.push(d);
  ls.set("dirty", S.dirty);
}
async function syncWearables(force) {
  if (!sb || !S.user || !navigator.onLine) return;
  if (!S.links.oura && !S.links.strava) return;
  const last = ls.get("wsync", 0);
  if (!force && Date.now() - last < 15 * 60e3) return;
  ls.set("wsync", Date.now());
  setSync("Syncing Oura · Garmin", "");
  try {
    const { data, error } = await sb.functions.invoke("fx-sync", { body: { action: "sync" } });
    if (error) throw error;
    await loadCloud(); setSync("Synced", "ok");
    if (force) toast(syncMsg(data));
    render();
  } catch (e) { console.warn(e); setSync("Sync failed", "bad"); if (force) toast(nice(e)); }
}
const syncMsg = d => { if (!d) return "Synced."; const p = []; if (d.oura != null) p.push(`${d.oura} Oura days`); if (d.strava != null) p.push(`${d.strava} Garmin activities`); return p.length ? "Synced: " + p.join(", ") + "." : "Synced."; };
// a raw browser error never reaches the driver as-is
function nice(e) {
  const m = String((e && (e.message || e.error_description || e)) || "");
  if (/load failed|failed to fetch|networkerror|network request failed/i.test(m)) return navigator.onLine ? "Couldn't reach the VCASO server. If you opened a preview copy, open the app from its home-screen icon instead." : "No signal. Saved on the phone; it syncs when you're back online.";
  if (/invalid login|invalid credentials/i.test(m)) return "That username or password didn't match.";
  if (/jwt|not signed in|401/i.test(m)) return "Your login has expired. Sign in again from Settings.";
  if (/not configured|client id/i.test(m)) return "That connection isn't switched on yet on the server. Riki needs to add the app keys.";
  return m.length > 140 ? m.slice(0, 140) + "…" : m || "Something went wrong.";
}

/* ---------- small UI helpers ---------- */
let toastT = null;
function toast(m, ms = 2800) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
const I = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  fuel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 3v8a2 2 0 0 0 4 0V3M9 11v10M16 21V3c2.5 1.5 3.5 4 3.5 7s-1.5 4-3.5 4"/></svg>',
  rec: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  score: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 21h12M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/></svg>',
};
const SEC = { train: "tr", fuel: "nu", rec: "rc", cog: "cg", score: "sc" };
const TYPE_C = t => /^run_/.test(t) ? "var(--tr)" : t === "mob" || t === "recover" ? "var(--rc)" : t === "act" ? "var(--cg)" : t === "moved" ? "var(--warn)" : "var(--tr)";

/* chrome: the mark is the way home on every screen except home itself, the player and drills */
function chrome(kind) {
  const home = kind === "home", full = kind === "full";
  const img = `<img src="${window.FX_LOGO}" alt="VCASO Performance">`;
  $("#mark").innerHTML = full ? `<span class="fx-mark" style="visibility:hidden">${img}</span>`
    : home ? `<span class="fx-mark">${img}</span>`
    : `<button class="fx-mark" data-act="home" aria-label="Home">${img}</button>`;
  $("#sideR").innerHTML = full ? "" : `<button class="iconbtn" data-go="#/me" aria-label="Settings">${I.gear}</button>`;
  $("#sideL").innerHTML = full ? "" : (S.user || S.mode === "local") ? `<span class="sync" id="sync"><i></i><span>${S.mode === "local" ? "On this phone" : navigator.onLine ? "" : "Offline"}</span></span>` : "";
  const tab = S.route[0] || "";
  const tabs = [["", "Today", I.today, "var(--ink)"], ["plan", "Plan", I.plan, "var(--tr)"], ["fuel", "Fuel", I.fuel, "var(--nu)"], ["rec", "Recover", I.rec, "var(--rc)"], ["score", "Score", I.score, "var(--sc)"]];
  const map = { day: "plan", drill: "", me: "" };
  const cur = map[tab] ?? tab;
  $("#tabs").innerHTML = full || !S.profile ? "" : `<div class="wrap">${tabs.map(([r, l, ic, c]) => `<a href="#/${r}" style="--c:${c}" ${cur === r ? 'aria-current="page"' : ""}>${ic}<span>${l}</span></a>`).join("")}</div>`;
  $("#main").classList.toggle("full", full || !S.profile);
}

/* ---------- router ---------- */
function route() {
  S.route = (location.hash.replace(/^#\/?/, "").split("?")[0] || "").split("/").filter(Boolean);
  render();
}
function render() {
  const [r, a] = S.route;
  if (S.mode == null) { chrome("full"); return viewWelcome(); }
  if (!S.profile || !S.profile.ready) { chrome("full"); return viewOnboard(); }
  if (r === "go") { chrome("full"); return viewPlayer(a || todayISO()); }
  if (r === "drill") { chrome("full"); return viewDrill(a); }
  chrome(!r ? "home" : "page");
  const v = { "": viewToday, plan: viewPlan, day: viewDay, fuel: viewFuel, rec: viewRecover, score: viewScore, me: viewMe }[r || ""] || viewToday;
  $("#main").innerHTML = v(a);
  window.scrollTo(0, S.keepScroll || 0); S.keepScroll = 0;
  afterRender();
}
function afterRender() { document.querySelectorAll("[data-autofocus]").forEach(e => e.focus()); }
window.addEventListener("hashchange", () => { stopPlayer(); route(); });

/* ---------- welcome / login ---------- */
function viewWelcome(msg) {
  $("#main").innerHTML = `<div class="login">
    <h1>Train like a racing driver</h1>
    <p>Sign in with your VCASO login so the plan, Oura and Garmin sync between your phone and iPad.</p>
    <form id="loginForm">
      <label class="f">Username<input type="text" id="lgU" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="e.g. riki" required></label>
      <label class="f">Password<input type="password" id="lgP" autocomplete="current-password" required></label>
      ${msg ? `<div class="err">${esc(msg)}</div>` : ""}
      <button class="btn primary big" type="submit">Sign in</button>
    </form>
    <button class="btn big" data-act="local">Use on this device only</button>
    <p style="font-size:.8rem">Without an account there's no Oura, Garmin or morning alerts, and data stays on this device. You can sign in later from Settings.</p>
  </div>`;
}
async function doLogin(form) {
  const btn = form.querySelector("button"); btn.disabled = true; btn.textContent = "Signing in…";
  if (!sb) return viewWelcome("The login service didn't load. Check your signal, or use this device only for now.");
  let u = $("#lgU").value.trim().toLowerCase();
  const ALIAS = { riki: "riki@rikichristo.com" };
  if (ALIAS[u]) u = ALIAS[u]; else if (!u.includes("@")) u += "@drivers.rikichristo.com";
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email: u, password: $("#lgP").value });
    if (error) throw error;
    S.user = data.user; S.mode = "cloud"; ls.set("mode", "cloud");
    await loadCloud().catch(e => console.warn(e));
    await flush();
    location.hash = "#/"; route(); pushInit(); syncWearables(true);
  } catch (e) { viewWelcome(nice(e)); }
}

/* ---------- onboarding: stats first time, in the app ---------- */
function viewOnboard() {
  const o = S.ob = Object.assign({ step: 1, sex: "m", hasBar: false, notifyWd: "07:00", notifyWe: "08:30", start: todayISO() }, S.profile || {}, S.ob);
  const st = o.step;
  const dots = `<div class="steps">${[1, 2, 3].map(i => `<i class="${i <= st ? "on" : ""}"></i>`).join("")}</div>`;
  let body = "";
  if (st === 1) body = `<h1>Your numbers</h1><p>Straight numbers. They set your calorie target and how fast we take the weight off.</p>
    <form class="box" id="ob1">
      <label class="f">First name<input type="text" id="o_name" value="${esc(o.name || "")}" required autocomplete="given-name"></label>
      <div class="grid2"><label class="f">Date of birth<input type="date" id="o_dob" value="${esc(o.dob || "")}" required></label>
      <label class="f">Sex<select id="o_sex"><option value="m" ${o.sex === "m" ? "selected" : ""}>Male</option><option value="f" ${o.sex === "f" ? "selected" : ""}>Female</option></select></label></div>
      <div class="grid3"><label class="f">Height (cm)<input type="number" id="o_h" inputmode="decimal" step="0.5" value="${esc(o.height || "")}" required></label>
      <label class="f">Weight (kg)<input type="number" id="o_w" inputmode="decimal" step="0.1" value="${esc(o.weight || "")}" required></label>
      <label class="f">Target (kg)<input type="number" id="o_t" inputmode="decimal" step="0.1" value="${esc(o.target || "")}" required></label></div>
      <button class="btn primary big" type="submit">Next</button></form>`;
  if (st === 2) body = `<h1>Your training</h1><p>Running and calisthenics, every day, anywhere. Day one is the baseline test.</p>
    <form class="box" id="ob2">
      <label class="f">Pull-up bar where you train most?<div class="seg" data-seg="hasBar"><button type="button" aria-pressed="${o.hasBar}" data-v="1">Yes</button><button type="button" aria-pressed="${!o.hasBar}" data-v="0">No</button></div><small>No bar? You get table rows and towel work instead.</small></label>
      <label class="f">Max heart rate (optional)<input type="number" id="o_hr" inputmode="numeric" placeholder="Leave blank to estimate" value="${esc(o.hrMax || "")}"><small>From a hard Garmin effort if you know it. Sets your zones.</small></label>
      <label class="f">Baseline test day<input type="date" id="o_start" value="${esc(o.start)}" min="${todayISO()}" required><small>The programme starts here. Test first, then we build.</small></label>
      <div class="row"><button class="btn" type="button" data-act="ob-back">Back</button><button class="btn primary grow" type="submit">Next</button></div></form>`;
  if (st === 3) body = `<h1>Morning call</h1><p>One alert every morning with today's session. Pick when.</p>
    <form class="box" id="ob3">
      <div class="grid2"><label class="f">Mon–Fri<input type="time" id="o_wd" value="${esc(o.notifyWd)}" required></label>
      <label class="f">Sat–Sun<input type="time" id="o_we" value="${esc(o.notifyWe)}" required></label></div>
      <small class="muted">You'll switch notifications on from the Today screen once the app is on your home screen.</small>
      <div class="row"><button class="btn" type="button" data-act="ob-back">Back</button><button class="btn primary grow" type="submit">Build my plan</button></div></form>`;
  $("#main").innerHTML = `<div class="login">${dots}${body}</div>`;
}
function obSubmit(id) {
  const o = S.ob, v = s => $(s).value;
  if (id === "ob1") Object.assign(o, { name: v("#o_name").trim(), dob: v("#o_dob"), sex: v("#o_sex"), height: +v("#o_h"), weight: +v("#o_w"), target: +v("#o_t"), step: 2 });
  if (id === "ob2") Object.assign(o, { hrMax: +v("#o_hr") || null, start: v("#o_start") || todayISO(), step: 3 });
  if (id === "ob3") {
    Object.assign(o, { notifyWd: v("#o_wd"), notifyWe: v("#o_we") });
    const { step, ...p } = o;
    S.profile = { ...p, ready: true, created: todayISO(), baseline: (S.profile && S.profile.baseline) || {}, moves: [], events: [], notifyOn: true };
    D(S.profile.start).w = S.profile.weight;
    touch(); touch(S.profile.start); S.ob = {};
    pushTitles();
    location.hash = "#/"; return route();
  }
  viewOnboard();
}

/* ---------- coach voice ---------- */
function coachLine(date) {
  const p = P(), { s, rd, v, st, day } = sessionOn(date), name = p.name || "Driver";
  if (date < p.start) return [`${diffDays(date, p.start)} days to the start line.`, `Baseline test on ${fmtDay(p.start)}. Sleep well, eat well, turn up ready.`];
  if (s.type === "moved") return ["Session moved to tomorrow.", "Tomorrow is non-negotiable. Log your food, hit your water, check in."];
  if (v) return ["Verified by Garmin. Points banked.", `${s.title} done. That's the standard, ${name}. Now refuel: protein within the hour.`];
  if (st === "done") return ["Logged. Make it count in full.", "Sync Garmin to Strava so the session verifies. Self-reported only scores 70%."];
  const yest = addDays(date, -1);
  const ys = yest >= p.start ? sessionOn(yest) : null;
  const missedY = ys && ys.s.type !== "moved" && !ys.v && ys.st !== "done";
  if (s.adapted === "red") return ["Red flag. No cardio today.", `${rd.why.join(" · ")}. Protect the engine: recovery protocol, fluids, early night. It still counts.`];
  if (s.adapted === "amber") return ["Amber. Trimmed, not cancelled.", `${rd.why.join(" · ")}. Quality over volume today. Feel good after the warm-up? You can run it as planned.`];
  if (s.type === "test") return ["Baseline day. Everything starts here.", "Honest numbers, full effort. This is the lap everything else is measured against."];
  if (s.type === "act") return ["Race day. Activate, don't fatigue.", "Fifteen minutes before the first session. Wake the body, prime the reactions."];
  if (missedY) return [`Yesterday didn't happen. Today does, ${name}.`, `${s.title}. ${fmtMin(s.est)}. No negotiating with yourself.`];
  return [rd.light === "green" && S.oura[date] ? `Green light, ${name}. Go to work.` : `${name}, today's job: ${s.title.split(" · ")[0].toLowerCase()}.`, `${s.title}. ${fmtMin(s.est)}. Get it done before the day gets in the way.`];
}

/* ---------- TODAY ---------- */
function viewToday() {
  const date = todayISO(), p = P();
  const [h, sub] = coachLine(date);
  const parts = [`<div class="card"><div class="coach">${esc(h)}<small>${esc(sub)}</small></div></div>`];
  parts.push(pushCard());
  parts.push(readinessCard(date, true));
  parts.push(sessionCard(date, true));
  parts.push(fuelMini(date));
  parts.push(cogCard(date));
  parts.push(scoreMini());
  parts.push(raceCard(date));
  return parts.join("");
}

function readinessCard(date, today) {
  const o = S.oura[date], day = S.days[date] || {}, { rd } = sessionOn(date);
  const light = o || day.ci ? rd.light : "none";
  const lbl = { green: "Green light", amber: "Amber", red: "Red flag", none: "No data yet" }[light];
  const stat = (k, v, u, s, cls) => `<div class="stat"><div class="k">${k}</div><div class="v ${cls || ""}">${v ?? "—"}${v != null && u ? `<small>${u}</small>` : ""}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
  const tcls = x => x == null ? "" : x < 55 ? "bad" : x < 70 ? "warn" : "";
  const stats = o ? `<div class="stats">
      ${stat("Readiness", o.readiness, "", "", tcls(o.readiness))}
      ${stat("Sleep", o.sleep_score, "", o.sleep_s ? fmtMin(Math.round(o.sleep_s / 60)) : "", tcls(o.sleep_score))}
      ${stat("HRV", o.hrv != null ? Math.round(o.hrv) : null, "ms")}
      ${stat("Rest HR", o.rhr != null ? Math.round(o.rhr) : null, "bpm", p_rhr(), P().rhrBase && o.rhr - P().rhrBase >= 4 ? "warn" : "")}
      ${stat("Temp", o.temp_dev != null ? (o.temp_dev > 0 ? "+" : "") + r1(o.temp_dev) : null, "°C", "", o.temp_dev >= 0.5 ? "bad" : o.temp_dev >= 0.3 ? "warn" : "")}
    </div>` : S.links.oura ? `<p class="muted" style="font-size:.88rem">Oura hasn't synced today's night yet. Open the Oura app to push it, then <button class="link" data-act="wsync">sync</button>.</p>`
    : `<p class="muted" style="font-size:.88rem">Connect Oura in <a href="#/rec">Recover</a> and readiness reads itself every morning.</p>`;
  const ci = day.ci;
  const ciRow = ci ? `<div class="row" style="font-size:.84rem"><span class="chip">Feel ${ci.feel}/5</span><span class="chip">Sore ${ci.sore}/5</span>${ci.sleep != null ? `<span class="chip">${ci.sleep} h sleep</span>` : ""}${ci.sick ? `<span class="chip bad">Unwell</span>` : ""}${day.w ? `<span class="chip">${day.w} kg</span>` : ""}<button class="btn sm ghost" data-act="checkin" data-d="${date}">Edit</button></div>`
    : `<button class="btn ${today ? "primary" : ""} big" data-act="checkin" data-d="${date}">Morning check-in + weigh-in</button>`;
  return `<div class="card" data-s="rc"><div class="card-h"><span class="tag">Recovery</span><div class="r"><div class="light ${light}"><span class="lamp"></span><b style="font-size:.86rem">${lbl}</b></div></div></div>
    ${stats}${rd.why.length && light !== "green" ? `<div class="${light === "red" ? "bad" : "warn"}" style="font-size:.86rem">${esc(rd.why.join(" · "))}</div>` : ""}${ciRow}</div>`;
}
const p_rhr = () => P().rhrBase ? `norm ${Math.round(P().rhrBase)}` : "";

function sessionCard(date, today) {
  const { s, v, st, day } = sessionOn(date), p = P();
  if (date < p.start) return `<div class="card" data-s="tr"><div class="card-h"><span class="tag">Training</span></div><div class="sess-title">Programme starts ${esc(fmtDay(p.start))}</div><a class="btn" href="#/plan">See the plan</a></div>`;
  if (s.type === "moved") return `<div class="card" data-s="tr"><div class="card-h"><span class="tag">Training</span><span class="chip warn">Moved</span></div><div class="sess-title">Moved to tomorrow</div><p class="muted" style="font-size:.88rem">Everything slides a day. Sunday still closes the week.</p></div>`;
  const status = v ? `<span class="chip ok"><span class="dot"></span>Verified · Garmin</span>` : st === "done" ? `<span class="chip solid">Done</span>` : "";
  const mv = FX.canMove(date, p);
  const ph = s.phase || FX.phase(date, p);
  const vline = v ? `<div class="blk"><b>${esc(v.name || v.sport)}</b><div class="d">${esc(v.sport)} · ${fmtMin(Math.round(v.dur_s / 60))}${v.dist_m ? ` · ${r1(v.dist_m / 1000)} km` : ""}${v.avg_hr ? ` · ${Math.round(v.avg_hr)} bpm avg` : ""}</div></div>` : "";
  const adaptLine = s.adapted ? `<div class="blk" style="border-color:${s.adapted === "red" ? "rgba(255,90,78,.5)" : "rgba(255,178,63,.5)"}"><b class="${s.adapted === "red" ? "bad" : "warn"}">${s.adapted === "red" ? "Swapped for recovery" : "Trimmed for today"}</b><div class="cue">Was: ${esc(s.original)}</div>${s.adapted === "amber" && !st ? `<div><button class="btn sm" data-act="override" data-d="${date}">I feel good. Run it as planned</button></div>` : ""}</div>` : day.override ? `<div class="cue warn" style="font-size:.82rem">Running as planned against the amber flag. Listen to the body.</div>` : "";
  return `<div class="card" data-s="${s.heat ? "heat" : "tr"}">
    <div class="card-h"><span class="tag">${today ? "Today's session" : esc(fmtDay(date))}</span><div class="r">${status}</div></div>
    <div><div class="sess-title">${esc(s.title)}</div>
    <div class="sess-meta" style="margin-top:8px"><span class="chip">${fmtMin(s.est)}</span><span class="chip">${esc(ph.label)}</span>${s.deload ? `<span class="chip">Lighter week</span>` : ""}${s.heat ? `<span class="chip" style="color:var(--heat);border-color:rgba(255,122,69,.5)">Heat block</span>` : ""}${s.fromMove ? `<span class="chip warn">Moved in · 85%</span>` : ""}</div></div>
    ${s.note ? `<p class="soft" style="font-size:.9rem">${esc(s.note)}</p>` : ""}
    ${adaptLine}${vline}
    <div class="blocks">${summaryBlocks(s)}</div>
    ${v || st === "done" ? `<div class="row">${!v ? `<button class="btn sm" data-act="undo" data-d="${date}">Undo done</button>` : ""}<a class="btn sm" href="#/day/${date}">Details</a></div>`
      : `<a class="btn primary big" href="#/go/${date}">${s.type === "test" ? "Start the test" : "Start session"}</a>
      <div class="row"><button class="btn grow" data-act="done" data-d="${date}">Mark done</button>${today ? `<button class="btn grow" data-act="move" data-d="${date}" ${mv.ok ? "" : "disabled"}>Move to tomorrow${mv.ok ? ` · ${mv.left} left` : ""}</button>` : ""}</div>
      ${today && !mv.ok ? `<div class="muted" style="font-size:.8rem">${esc(mv.why)}</div>` : ""}`}
  </div>`;
}
function summaryBlocks(s) {
  return s.blocks.map(b => {
    if (b.kind === "warm") return `<div class="blk"><b>${esc(b.name)}</b><div class="d">${b.items.length} moves · ${Math.round(b.items.reduce((t, i) => t + i[1], 0) / 60)} min</div></div>`;
    if (b.kind === "set") return `<div class="blk"><b>${esc(b.n)}</b><div class="d">${b.sets} × ${b.r} · rest ${b.rest}s</div>${b.cue ? `<div class="cue">${esc(b.cue)}</div>` : ""}</div>`;
    if (b.kind === "hold") return `<div class="blk"><b>${esc(b.name ? b.name + " · " : "")}${esc(b.n)}</b><div class="d">${b.sets} × ${b.t}s · rest ${b.rest}s</div>${b.cue ? `<div class="cue">${esc(b.cue)}</div>` : ""}</div>`;
    if (b.kind === "circuit") return `<div class="blk"><b>${esc(b.name)} · ${b.rounds} rounds</b><ul>${b.items.map(i => `<li>${esc(i.n)} · ${i.r ? i.r + " reps" : i.t + "s"}</li>`).join("")}</ul></div>`;
    if (b.kind === "run") { const tot = b.segs.reduce((t, g) => t + g.min, 0); return `<div class="blk"><b>${esc(b.name)} · ${tot} min</b><div class="cue">${esc(b.cue || "")}</div></div>`; }
    if (b.kind === "test") return `<div class="blk"><b>${esc(b.name)}</b><div class="cue">${esc(b.cue)}</div></div>`;
    if (b.kind === "drill") return `<div class="blk"><b>${esc(b.name)}</b><div class="d">${esc(FXD.INFO[b.drill].name)}</div></div>`;
    if (b.kind === "note") return `<div class="blk ${b.heat ? "heat" : ""}"><div class="cue">${esc(b.text)}</div></div>`;
    return "";
  }).join("");
}

function fuelMini(date) {
  const day = S.days[date] || {}, t = FX.targets(P(), day.w || lastWeight(), true), tot = FX.foodTotals(day.food);
  const left = t.kcal - Math.round(tot.kcal);
  return `<a class="card" data-s="nu" href="#/fuel" style="text-decoration:none;color:inherit">
    <div class="card-h"><span class="tag">Fuel</span><div class="r"><span class="mono" style="font-size:.78rem">${left >= 0 ? `${left} kcal left` : `<span class="warn">${-left} kcal over</span>`}</span></div></div>
    ${macro("Calories", tot.kcal, t.kcal, "kcal")}${macro("Protein", tot.p, t.protein, "g")}
    <div class="macro"><span class="n">Water</span><div class="bar" style="--c:var(--nu)"><i style="width:${Math.min(100, 100 * (day.water || 0) / t.water)}%"></i></div><span class="x">${r1((day.water || 0) / 1000)} / ${r1(t.water / 1000)} L</span></div>
    </a>`;
}
function macro(n, v, t, u) {
  const pct = t ? 100 * v / t : 0, over = n === "Calories" && pct > 110;
  return `<div class="macro"><span class="n">${n}</span><div class="bar ${over ? "over" : ""}" style="--c:var(--nu)"><i style="width:${Math.min(100, pct)}%"></i></div><span class="x">${Math.round(v)} / ${t} ${u}</span></div>`;
}

function cogCard(date) {
  const drills = (S.days[date] || {}).drills || [], bt = S.bt[date];
  const best = k => { const all = Object.values(S.days).flatMap(d => (d.drills || []).filter(x => x.kind === k && x.avg)); return all.length ? Math.min(...all.map(x => x.avg)) : null; };
  return `<div class="card" data-s="cg"><div class="card-h"><span class="tag">Reactions</span><div class="r">${drills.length || bt ? `<span class="chip ok"><span class="dot"></span>Done today</span>` : `<span class="chip">3 min</span>`}</div></div>
    <div class="grid3">${["lights", "gonogo", "peripheral"].map(k => { const d = drills.filter(x => x.kind === k).pop(), b = best(k);
      return `<a class="stat" href="#/drill/${k}" style="text-decoration:none;color:inherit"><div class="k">${FXD.INFO[k].name}</div><div class="v">${d && d.avg ? d.avg : "—"}<small>${d && d.avg ? "ms" : ""}</small></div><div class="s">${b ? `PB ${b} ms` : "Tap to run"}</div></a>`; }).join("")}</div>
    <a class="btn" href="${esc(CFG.brakeTrainer)}" target="_blank" rel="noopener">On the rig: Brake Trainer${bt ? ` · ${bt} runs today` : ""}</a></div>`;
}

function scoreMini() {
  const sc = FX.weekScore(todayISO(), ctx());
  const streak = calcStreak();
  return `<a class="card" data-s="sc" href="#/score" style="text-decoration:none;color:inherit">
    <div class="card-h"><span class="tag">This week</span><div class="r"><span class="chip">${streak} day streak</span></div></div>
    <div class="row" style="align-items:baseline"><span class="sess-title" style="font-size:2rem">${sc.total ?? "—"}</span><span class="muted">/ 100 so far · ${esc(FX.grade(sc.total))}</span></div>
    ${sc.fixes[0] ? `<div class="fix"><span>01</span><div>${esc(sc.fixes[0])}</div></div>` : ""}</a>`;
}
function calcStreak() {
  let n = 0, d = todayISO();
  const p = P();
  const today = sessionOn(d); if (today.v || today.st === "done") n++;
  d = addDays(d, -1);
  while (d >= p.start && n < 400) {
    const x = sessionOn(d);
    if (x.s.type === "moved") { d = addDays(d, -1); continue; }
    if (x.v || x.st === "done") n++; else break;
    d = addDays(d, -1);
  }
  return n;
}

function raceCard(date) {
  const e = FX.nextEvent(date, P()); if (!e) return "";
  const n = diffDays(date, e.from);
  return `<a class="card" href="#/plan" style="text-decoration:none;color:inherit"><div class="card-h"><span class="tag">Next round</span><div class="r"><span class="chip">${n > 0 ? `${n} days` : "This weekend"}</span></div></div>
    <div><b>${e.r ? `R${e.r} · ` : ""}${esc(e.name)}</b><div class="muted" style="font-size:.84rem">${esc(e.circuit || "")} · ${fmtDay(e.from, { day: "numeric", month: "short" })}–${fmtDay(e.to, { day: "numeric", month: "short" })}${e.custom ? "" : " · provisional"}</div></div></a>`;
}

/* ---------- PLAN ---------- */
function viewPlan() {
  const off = +(new URLSearchParams(location.hash.split("?")[1] || "").get("w") || 0);
  const ref = addDays(todayISO(), off * 7), p = P(), wk = FX.weekPlan(ref, p);
  const ph = FX.phase(ref, p);
  const strip = wk.list.map((s, i) => {
    const d = wk.days[i], x = sessionOn(d);
    const cls = d === todayISO() ? "today" : "";
    const st = d < p.start ? "" : x.s.type === "moved" ? "moved" : x.v ? "done" : x.st === "done" ? "self" : x.s.adapted === "red" ? "red" : d < todayISO() ? "miss" : "";
    return `<a class="wd ${cls} ${st}" href="#/day/${d}"><span class="n">${["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"][i]}</span><span class="d">${FX.parse(d).getDate()}</span><span class="s"></span></a>`;
  }).join("");
  const list = wk.list.map((s0, i) => {
    const d = wk.days[i], x = sessionOn(d), s = x.s;
    const before = d < p.start;
    const st = before ? "" : x.v ? `<span class="chip ok">Verified</span>` : x.st === "done" ? `<span class="chip solid">Done</span>` : s.type === "moved" ? `<span class="chip warn">Moved</span>` : d < todayISO() ? `<span class="chip bad">Missed</span>` : s.adapted ? `<span class="chip ${s.adapted === "red" ? "bad" : "warn"}">${s.adapted === "red" ? "Recovery" : "Trimmed"}</span>` : "";
    return `<a class="plan-day ${d === todayISO() ? "today" : d < todayISO() ? "past" : ""}" href="#/day/${d}" style="--c:${before ? "var(--line2)" : TYPE_C(s.type)};text-decoration:none">
      <div class="when">${fmtDay(d, { weekday: "short" })}<b>${FX.parse(d).getDate()}</b></div>
      <div style="min-width:0"><div class="t">${before ? "—" : esc(s.title)}</div><div class="m">${before ? "Before the start" : s.type === "moved" ? "Slid to the next day" : fmtMin(s.est) + (s.heat ? " · heat" : "") + (s.fromMove ? " · moved in" : "")}</div></div>
      <div>${st}</div></a>`;
  }).join("");
  const season = FX.events(p).map(e => {
    const past = e.to < todayISO(), next = FX.nextEvent(todayISO(), p) === e;
    return `<div class="race ${past ? "past" : ""} ${next ? "next" : ""}"><span class="rn">${e.r ? "R" + e.r : "•"}</span><div><b>${esc(e.name)}</b><small>${esc(e.circuit || e.note || "")}${e.hot ? " · heat prep" : ""}</small></div><span class="mono" style="font-size:.74rem;color:var(--muted)">${fmtDay(e.from, { day: "numeric", month: "short" })}–${fmtDay(e.to, { day: "numeric" })}</span></div>`;
  }).join("");
  return `<div class="card" data-s="tr">
      <div class="card-h"><a class="iconbtn" href="#/plan?w=${off - 1}" aria-label="Previous week">${I.back}</a><div style="text-align:center;flex:1"><div class="eyebrow">${off === 0 ? "This week" : off === 1 ? "Next week" : off === -1 ? "Last week" : "Week of"}</div><b>${fmtDay(wk.mon, { day: "numeric", month: "short" })} – ${fmtDay(addDays(wk.mon, 6), { day: "numeric", month: "short" })}</b></div><a class="iconbtn" href="#/plan?w=${off + 1}" aria-label="Next week" style="transform:scaleX(-1)">${I.back}</a></div>
      <div class="week">${strip}</div>
      <div class="row"><span class="chip">${esc(ph.label)}</span>${FX.isDeload(ref) && ["base", "build"].includes(ph.id) ? `<span class="chip">Lighter week</span>` : ""}<span class="chip ${wk.movesLeft ? "" : "warn"}">${wk.movesLeft} of ${FX.MAX_MOVES} moves left</span></div>
      ${wk.dropped.length ? `<div class="muted" style="font-size:.82rem">Dropped this week by the moves: ${esc(wk.dropped.map(s => s.title).join(", "))}.</div>` : ""}
    </div>
    <div style="display:grid;gap:8px">${list}</div>
    <div class="card"><div class="card-h"><span class="tag">FIA F3 ${FX.SEASON}</span><div class="r"><button class="btn sm" data-act="add-event">Add test / event</button></div></div>
      <p class="muted" style="font-size:.82rem">Dates follow the F1 weekends and stay provisional until the FIA publishes the F3 timetable. The plan tapers into every round and builds in the gaps.</p>
      <div>${season}</div></div>`;
}

function viewDay(date) {
  date = date || todayISO();
  const p = P(), x = sessionOn(date), acts = actsOn(date);
  return `<div class="row"><a class="btn sm" href="#/plan">${I.back.replace('<svg', '<svg width="14" height="14"')} Plan</a><span class="muted" style="margin-left:auto">${esc(fmtDay(date, { weekday: "long", day: "numeric", month: "long" }))}</span></div>
    ${sessionCard(date, date === todayISO())}
    ${date <= todayISO() && date >= p.start ? readinessCard(date, false) : ""}
    ${acts.length ? `<div class="card"><div class="card-h"><span class="tag">Garmin activities</span></div>${acts.map(a => `<div class="blk"><b>${esc(a.name || a.sport)}</b><div class="d">${esc(a.sport)} · ${fmtMin(Math.round((a.dur_s || 0) / 60))}${a.dist_m ? ` · ${r1(a.dist_m / 1000)} km` : ""}${a.avg_hr ? ` · ${Math.round(a.avg_hr)} bpm` : ""}</div></div>`).join("")}</div>` : ""}
    ${date < todayISO() && date >= p.start && !x.v && x.st !== "done" && x.s.type !== "moved" ? `<div class="notice"><b>Did this one but the Garmin didn't record?</b><span>Mark it done. It scores as self-reported.</span></div>` : ""}`;
}

/* ---------- actions ---------- */
function markDone(date, extra) {
  const d = D(date); d.s = Object.assign({ status: "done", at: new Date().toISOString() }, d.s && d.s.status === "done" ? d.s : {}, extra || {});
  touch(date);
}
function moveSession(date) {
  const p = S.profile, mv = FX.canMove(date, P());
  if (!mv.ok) return toast(mv.why);
  if (!confirm(`Move today's session to tomorrow? Everything slides a day and the last session of the week drops. Moved sessions score 85%. ${mv.left - 1} move${mv.left - 1 === 1 ? "" : "s"} left after this.`)) return;
  p.moves = [...(p.moves || []), date]; touch(); touch(date); touch(addDays(date, 1));
  toast("Moved. Tomorrow is non-negotiable."); render();
}

/* ---------- check-in sheet ---------- */
function openCheckin(date) {
  const day = D(date), ci = day.ci || {}, hasOura = !!S.oura[date];
  const seg = (k, n, v, lbls) => `<div class="seg" data-ci="${k}">${Array.from({ length: n }, (_, i) => `<button type="button" aria-pressed="${v === i + 1}" data-v="${i + 1}">${lbls ? lbls[i] : i + 1}</button>`).join("")}</div>`;
  sheet(`<h2>Morning check-in</h2>
    <label class="f">Weight (kg) <small>Straight out of bed, after the toilet, before food.</small><input type="number" id="ci_w" inputmode="decimal" step="0.1" value="${esc(day.w || "")}" placeholder="${esc(lastWeight() || "")}"></label>
    ${hasOura ? "" : `<label class="f">Hours of sleep<input type="number" id="ci_sleep" inputmode="decimal" step="0.25" value="${esc(ci.sleep ?? "")}"></label>`}
    <label class="f">How do you feel?${seg("feel", 5, ci.feel, ["Wrecked", "Flat", "OK", "Good", "Sharp"])}</label>
    <label class="f">Soreness${seg("sore", 5, ci.sore, ["None", "Light", "Some", "Heavy", "Can't move"])}</label>
    <label class="f">Any illness? Sore throat, fever, chest?${seg("sick", 2, ci.sick ? 2 : ci.feel ? 1 : null, ["No", "Yes"])}<small>Above the neck and mild: easy session. Below the neck or fever: no training, full stop.</small></label>
    <button class="btn primary big" data-act="ci-save" data-d="${date}">Save</button>`);
  S.ciDraft = { ...ci };
}
function saveCheckin(date) {
  const day = D(date), w = +$("#ci_w").value, sl = $("#ci_sleep");
  const ci = { ...S.ciDraft, sick: S.ciDraft.sick === 2 || S.ciDraft.sick === true };
  if (sl && sl.value !== "") ci.sleep = +sl.value;
  if (!ci.feel) return toast("How do you feel? Pick one.");
  if (!ci.sore) ci.sore = 1;
  day.ci = ci; if (w) day.w = w;
  touch(date); closeSheet();
  const rd = sessionOn(date).rd;
  toast(rd.light === "red" ? "Logged. Today is a recovery day." : rd.light === "amber" ? "Logged. Session trimmed." : "Logged. Go to work.");
  render();
}

/* ---------- sheets ---------- */
function sheet(html) { closeSheet(); const el = document.createElement("div"); el.className = "sheet"; el.id = "sheet"; el.innerHTML = `<div class="in"><div class="grab"></div>${html}</div>`; el.addEventListener("click", e => { if (e.target === el) closeSheet(); }); document.body.appendChild(el); }
function closeSheet() { const el = $("#sheet"); if (el) el.remove(); stopScan(); }

/* ---------- PLAYER ---------- */
function flatten(s) {
  const steps = [];
  for (const b of s.blocks) {
    if (b.kind === "warm") b.items.forEach(([n, t], i) => steps.push({ k: "timed", sec: b.name, n, t, next: true }));
    if (b.kind === "set") for (let i = 0; i < b.sets; i++) { steps.push({ k: "reps", sec: "Strength", n: b.n, r: b.r, set: i + 1, sets: b.sets, cue: b.cue }); if (i < b.sets - 1) steps.push({ k: "rest", t: b.rest, after: b.n }); else steps.push({ k: "rest", t: Math.min(60, b.rest), after: b.n }); }
    if (b.kind === "hold") for (let i = 0; i < b.sets; i++) { steps.push({ k: "timed", sec: b.name || "Hold", n: b.n, t: b.t, set: i + 1, sets: b.sets, cue: b.cue }); steps.push({ k: "rest", t: b.rest, after: b.n }); }
    if (b.kind === "circuit") for (let r = 0; r < b.rounds; r++) { b.items.forEach(it => steps.push(it.t ? { k: "timed", sec: `${b.name} · round ${r + 1}/${b.rounds}`, n: it.n, t: it.t } : { k: "reps", sec: `${b.name} · round ${r + 1}/${b.rounds}`, n: it.n, r: it.r })); if (r < b.rounds - 1) steps.push({ k: "rest", t: b.rest, after: `Round ${r + 1}` }); }
    if (b.kind === "run") steps.push({ k: "run", sec: b.name, n: b.name, segs: b.segs, cue: b.cue });
    if (b.kind === "test") steps.push(b.drill ? { k: "drill", sec: "Baseline test", n: b.name, drill: b.drill, test: b.id, cue: b.cue } : { k: "test", sec: "Baseline test", n: b.name, id: b.id, cue: b.cue, run: b.run, optional: b.optional });
    if (b.kind === "drill") steps.push({ k: "drill", sec: b.name, n: FXD.INFO[b.drill].name, drill: b.drill });
    if (b.kind === "note") steps.push({ k: "note", sec: b.heat ? "Heat block" : "Note", n: b.text });
  }
  // a rest at the very end is pointless
  while (steps.length && steps[steps.length - 1].k === "rest") steps.pop();
  return steps;
}
let tick = null, wakeLock = null, actx = null;
function beep(f = 880, ms = 140, n = 1) {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); for (let i = 0; i < n; i++) { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; o.connect(g); g.connect(actx.destination); const t0 = actx.currentTime + i * (ms / 1000 + 0.08); g.gain.setValueAtTime(0.25, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + ms / 1000); o.start(t0); o.stop(t0 + ms / 1000); } } catch (e) {}
  try { navigator.vibrate && navigator.vibrate(n > 1 ? [80, 60, 80] : 60); } catch (e) {}
}
async function lockScreen() { try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {} }
function stopPlayer() { clearInterval(tick); tick = null; if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }

function viewPlayer(date) {
  const { s } = sessionOn(date);
  if (!S.player || S.player.date !== date) S.player = { date, steps: flatten(s), i: 0, startedAt: Date.now(), left: null, paused: false, test: {}, title: s.title };
  lockScreen();
  drawStep();
}
function drawStep() {
  const P_ = S.player, st = P_.steps[P_.i];
  stopTick();
  if (!st) return finishScreen();
  const pct = Math.round(100 * P_.i / P_.steps.length);
  const nxt = P_.steps.slice(P_.i + 1).find(x => x.k !== "rest");
  const head = `<div class="ph"><button class="btn sm" data-act="p-quit">End</button><span class="eyebrow" style="flex:1;text-align:center">${esc(P_.title)}</span><span class="mono r" style="font-size:.74rem;color:var(--muted)">${P_.i + 1}/${P_.steps.length}</span></div><div class="prog"><i style="width:${pct}%"></i></div>`;
  let body = "";
  if (st.k === "timed" || st.k === "rest") {
    if (P_.left == null) P_.left = st.t;
    const rest = st.k === "rest";
    body = `<div class="eyebrow" style="text-align:center">${esc(rest ? "Rest" : st.sec)}${st.set ? ` · set ${st.set}/${st.sets}` : ""}</div>
      <div class="big-ex" style="text-align:center">${esc(rest ? (nxt ? "Next: " + nxt.n : "Last one done") : st.n)}</div>
      <div class="clock ${rest ? "rest" : ""}" id="clk">${mmss(P_.left)}</div>
      ${st.cue ? `<p class="muted" style="text-align:center;font-size:.9rem">${esc(st.cue)}</p>` : ""}
      ${st.sets ? `<div class="setdots">${Array.from({ length: st.sets }, (_, i) => `<i class="${i < st.set ? "on" : ""}"></i>`).join("")}</div>` : ""}
      <div class="row"><button class="btn grow" data-act="p-pause">${P_.paused ? "Resume" : "Pause"}</button><button class="btn primary grow" data-act="p-next">${rest ? "Skip rest" : "Done"}</button></div>`;
    runTick();
  }
  if (st.k === "reps") body = `<div class="eyebrow" style="text-align:center">${esc(st.sec)}${st.set ? ` · set ${st.set}/${st.sets}` : ""}</div>
      <div class="big-ex" style="text-align:center">${esc(st.n)}</div>
      <div class="clock">${st.r}<span style="font-size:.3em;color:var(--muted);margin-left:8px">REPS</span></div>
      ${st.cue ? `<p class="muted" style="text-align:center;font-size:.9rem">${esc(st.cue)}</p>` : ""}
      ${st.sets ? `<div class="setdots">${Array.from({ length: st.sets }, (_, i) => `<i class="${i < st.set ? "on" : ""}"></i>`).join("")}</div>` : ""}
      <button class="btn primary big" data-act="p-next">Set done</button>`;
  if (st.k === "run") {
    if (P_.runStart == null) P_.runStart = null;
    const tot = st.segs.reduce((t, g) => t + g.min, 0);
    body = `<div class="eyebrow" style="text-align:center">${esc(st.sec)} · ${tot} min</div>
      <div class="big-ex" style="text-align:center" id="segName">${P_.runStart ? "" : "Start the Garmin, then go"}</div>
      <div class="clock" id="clk">${P_.runStart ? "" : "0:00"}</div><div class="clock-l" id="segLeft">${esc(st.segs[0].pace || "")}</div>
      <div class="segs" id="segs">${st.segs.map((g, i) => `<div class="${g.hard ? "hard" : ""}" data-i="${i}"><span>${esc(g.l)}</span><span class="mono">${g.min}:00 · ${esc(g.pace || "")}</span></div>`).join("")}</div>
      <p class="muted" style="font-size:.86rem">${esc(st.cue || "")}</p>
      ${P_.runStart ? `<div class="row"><button class="btn grow" data-act="p-pause">${P_.paused ? "Resume" : "Pause"}</button><button class="btn primary grow" data-act="p-next">Finish run</button></div>`
        : `<button class="btn primary big" data-act="p-runstart">Start the clock</button><button class="btn" data-act="p-next">Skip the clock, Garmin has it</button>`}`;
    if (P_.runStart) runTick();
  }
  if (st.k === "test") {
    const v = P_.test[st.id];
    body = `<div class="eyebrow" style="text-align:center">${esc(st.sec)}</div><div class="big-ex" style="text-align:center">${esc(st.n)}</div>
      <p class="soft" style="text-align:center">${esc(st.cue)}</p>
      ${st.run ? `<label class="f">Your time (mm:ss)<input type="text" id="tv" inputmode="numeric" placeholder="e.g. 27:30" value="${v ? mmss(v) : ""}"></label>`
        : `<label class="f">Result<input type="number" id="tv" inputmode="numeric" value="${v ?? ""}"></label>`}
      ${st.id === "plank" || st.id === "wallsit" ? `<button class="btn" data-act="p-stopwatch">${P_.sw ? "Stop" : "Start stopwatch"}</button><div class="clock" id="sw">${P_.sw ? "" : ""}</div>` : ""}
      <button class="btn primary big" data-act="p-test">Save and continue</button>${st.optional ? `<button class="btn ghost" data-act="p-next">Skip</button>` : ""}`;
  }
  if (st.k === "drill") body = `<div class="eyebrow" style="text-align:center">${esc(st.sec)}</div><div class="big-ex" style="text-align:center">${esc(st.n)}</div><div id="drillEl"></div>`;
  if (st.k === "note") body = `<div class="eyebrow" style="text-align:center">${esc(st.sec)}</div><p class="soft" style="font-size:1.05rem;text-align:center">${esc(st.n)}</p><button class="btn primary big" data-act="p-next">Got it</button>`;
  $("#main").innerHTML = `<div class="player">${head}${body}${nxt && st.k !== "rest" ? `<div class="upnext">Up next: ${esc(nxt.n)}</div>` : ""}</div>`;
  if (st.k === "drill") FXD.run(st.drill, $("#drillEl")).then(r => { if (!S.player) return; if (r) { r.at = new Date().toISOString(); const d = D(todayISO()); d.drills = [...(d.drills || []), r]; touch(todayISO()); if (st.test) P_.test[st.test] = r.avg; } nextStep(); });
}
function stopTick() { clearInterval(tick); tick = null; }
function runTick() {
  stopTick();
  const P_ = S.player, st = P_.steps[P_.i];
  tick = setInterval(() => {
    if (P_.paused) return;
    if (st.k === "run") {
      const el = (Date.now() - P_.runStart - (P_.pausedMs || 0)) / 1000;
      let acc = 0, cur = st.segs.length - 1;
      for (let i = 0; i < st.segs.length; i++) { if (el < acc + st.segs[i].min * 60) { cur = i; break; } acc += st.segs[i].min * 60; }
      const segLeft = Math.max(0, acc + st.segs[cur].min * 60 - el);
      if (P_.seg !== cur) { if (P_.seg != null) beep(st.segs[cur].hard ? 1100 : 660, 180, 2); P_.seg = cur; }
      if (segLeft <= 3 && segLeft > 0 && Math.ceil(segLeft) !== P_.lastBeep) { P_.lastBeep = Math.ceil(segLeft); beep(880, 90); }
      const c = $("#clk"); if (c) c.textContent = mmss(segLeft);
      const n = $("#segName"); if (n) n.textContent = st.segs[cur].l;
      const l = $("#segLeft"); if (l) l.textContent = `${st.segs[cur].pace || ""}${st.segs[cur].hr ? " · " + st.segs[cur].hr : ""} · total ${mmss(el)}`;
      document.querySelectorAll("#segs div").forEach((d, i) => { d.classList.toggle("on", i === cur); d.classList.toggle("past", i < cur); });
      return;
    }
    P_.left -= 1;
    if (P_.left <= 3 && P_.left > 0) beep(880, 90);
    const c = $("#clk"); if (c) c.textContent = mmss(Math.max(0, P_.left));
    if (P_.left <= 0) { beep(st.k === "rest" ? 1200 : 660, 200, 2); nextStep(); }
  }, 1000);
}
function nextStep() { const P_ = S.player; P_.i++; P_.left = null; P_.paused = false; P_.seg = null; drawStep(); window.scrollTo(0, 0); }
function finishScreen() {
  stopTick();
  const P_ = S.player, mins = Math.round((Date.now() - P_.startedAt) / 60000);
  $("#main").innerHTML = `<div class="player"><div class="coach" style="text-align:center">Session complete.<small>${mins} minutes. How hard was that?</small></div>
    <div class="seg" id="rpe">${Array.from({ length: 10 }, (_, i) => `<button type="button" data-v="${i + 1}" aria-pressed="false">${i + 1}</button>`).join("")}</div>
    <div class="muted" style="font-size:.8rem;text-align:center">1 easy chat · 5 working · 8 hard · 10 everything</div>
    <button class="btn primary big" data-act="p-save">Save session</button></div>`;
}
function savePlayer() {
  const P_ = S.player, date = P_.date;
  const rpe = +(document.querySelector("#rpe [aria-pressed=true]") || {}).dataset?.v || null;
  markDone(date, { rpe, dur: Math.round((Date.now() - P_.startedAt) / 1000), via: "app" });
  if (Object.keys(P_.test).length) {
    const b = S.profile.baseline = { ...(S.profile.baseline || {}), ...P_.test, done: true, date };
    S.profile.history = [...(S.profile.history || []), { date, ...P_.test }];
    S.profile.testDays = (S.profile.testDays || []).filter(d => d !== date);
    touch();
    toast("Baseline saved. Your plan has been recalibrated.");
  } else toast(sessionOn(date).v ? "Saved and verified." : "Saved. It verifies when Garmin syncs.");
  S.player = null; stopPlayer(); syncWearables(true);
  location.hash = "#/";
}

/* ---------- drills (standalone) ---------- */
function viewDrill(kind) {
  if (!FXD.INFO[kind]) { location.hash = "#/"; return; }
  const info = FXD.INFO[kind];
  $("#main").innerHTML = `<div class="player"><div class="ph"><a class="btn sm" href="#/">Close</a><span class="eyebrow" style="flex:1;text-align:center">${esc(info.name)}</span><span style="width:58px"></span></div>
    <p class="soft" style="text-align:center;font-size:.92rem">${esc(info.what)}</p><div id="drillEl"></div></div>`;
  FXD.run(kind, $("#drillEl")).then(r => {
    if (!r) { location.hash = "#/"; return; }
    r.at = new Date().toISOString();
    const d = D(todayISO()); d.drills = [...(d.drills || []), r]; touch(todayISO());
    const all = Object.values(S.days).flatMap(x => (x.drills || []).filter(y => y.kind === kind && y.avg));
    const pb = all.length && r.avg && r.avg <= Math.min(...all.map(x => x.avg));
    $("#drillEl").innerHTML = `<div class="drill"><div class="ms">${r.avg ?? "—"} ms</div>
      <div class="row" style="justify-content:center">${r.best ? `<span class="chip">Best ${r.best} ms</span>` : ""}${r.acc != null ? `<span class="chip ${r.acc < 85 ? "warn" : ""}">${r.acc}% accurate</span>` : ""}${r.jumps ? `<span class="chip bad">${r.jumps} jump start${r.jumps > 1 ? "s" : ""}</span>` : ""}${pb && all.length > 1 ? `<span class="chip ok">Personal best</span>` : ""}</div>
      <div class="row" style="width:100%"><a class="btn grow" href="#/">Done</a><button class="btn primary grow" data-act="drill-again" data-k="${kind}">Go again</button></div></div>`;
  });
}

/* ---------- FUEL ---------- */
const MEALS = [["b", "Breakfast"], ["l", "Lunch"], ["d", "Dinner"], ["s", "Snacks"]];
function viewFuel(date) {
  date = date || todayISO();
  const day = S.days[date] || {}, t = FX.targets(P(), day.w || lastWeight(), true), tot = FX.foodTotals(day.food);
  const food = day.food || [];
  const yest = S.days[addDays(date, -1)] || {};
  const meals = MEALS.map(([k, n]) => {
    const items = food.map((f, i) => ({ ...f, i })).filter(f => f.meal === k);
    const kc = items.reduce((s, f) => s + (+f.kcal || 0), 0);
    const yItems = (yest.food || []).filter(f => f.meal === k);
    return `<div class="meal"><div class="meal-h"><b>${n}</b><span class="k">${Math.round(kc)} kcal</span><button class="btn sm" data-act="food-add" data-m="${k}" data-d="${date}">Add</button></div>
      ${items.map(f => `<div class="fi"><div class="n">${esc(f.name)}<small>${f.g ? f.g + " g · " : ""}P ${Math.round(f.p || 0)} · C ${Math.round(f.c || 0)} · F ${Math.round(f.f || 0)}</small></div><span class="k">${Math.round(f.kcal)}</span><button data-act="food-del" data-i="${f.i}" data-d="${date}" aria-label="Remove">×</button></div>`).join("")}
      ${!items.length && yItems.length ? `<button class="btn sm ghost" data-act="food-repeat" data-m="${k}" data-d="${date}" style="justify-self:start">Repeat yesterday's ${n.toLowerCase()} · ${Math.round(yItems.reduce((s, f) => s + (+f.kcal || 0), 0))} kcal</button>` : ""}</div>`;
  }).join('<div class="divider"></div>');
  const glasses = Math.round(t.water / 250), have = Math.round((day.water || 0) / 250);
  return `<div class="card" data-s="nu">
      <div class="card-h"><a class="iconbtn" href="#/fuel/${addDays(date, -1)}" aria-label="Previous day">${I.back}</a><div style="flex:1;text-align:center"><div class="eyebrow">Fuel</div><b>${date === todayISO() ? "Today" : esc(fmtDay(date))}</b></div>${date < todayISO() ? `<a class="iconbtn" href="#/fuel/${addDays(date, 1)}" style="transform:scaleX(-1)" aria-label="Next day">${I.back}</a>` : `<span style="width:36px"></span>`}</div>
      <div class="stats"><div class="stat"><div class="k">Target</div><div class="v">${t.kcal}<small>kcal</small></div></div><div class="stat"><div class="k">Eaten</div><div class="v">${Math.round(tot.kcal)}</div></div><div class="stat"><div class="k">Left</div><div class="v ${t.kcal - tot.kcal < -t.kcal * 0.1 ? "warn" : ""}">${Math.round(t.kcal - tot.kcal)}</div></div></div>
      ${macro("Calories", tot.kcal, t.kcal, "kcal")}${macro("Protein", tot.p, t.protein, "g")}${macro("Carbs", tot.c, t.carbs, "g")}${macro("Fat", tot.f, t.fat, "g")}
    </div>
    <div class="card" data-s="nu"><div class="card-h"><span class="tag">Meals</span><div class="r"><button class="btn sm primary" data-act="food-add" data-m="${autoMeal()}" data-d="${date}">Scan barcode</button></div></div>${meals}</div>
    <div class="card" data-s="nu"><div class="card-h"><span class="tag">Hydration</span><div class="r"><span class="mono" style="font-size:.8rem">${r1((day.water || 0) / 1000)} / ${r1(t.water / 1000)} L</span></div></div>
      <div class="water">${Array.from({ length: Math.max(glasses, have) }, (_, i) => `<i class="${i < have ? "on" : ""}"></i>`).join("")}</div>
      <div class="row"><button class="btn grow" data-act="water" data-v="-250" data-d="${date}">−250</button><button class="btn grow" data-act="water" data-v="250" data-d="${date}">+250 ml</button><button class="btn primary grow" data-act="water" data-v="500" data-d="${date}">+500 ml</button></div></div>
    ${bodyCard()}`;
}
const autoMeal = () => { const h = new Date().getHours(); return h < 11 ? "b" : h < 15 ? "l" : h < 21 ? "d" : "s"; };

function bodyCard() {
  const p = P(), pts = Object.keys(S.days).filter(d => S.days[d].w).sort().map(d => ({ date: d, w: +S.days[d].w }));
  const tr = FX.trend(pts), last = tr[tr.length - 1], t = FX.targets(p, last ? last.w : p.weight, true);
  const change = last && pts.length > 1 ? r1(last.avg - pts[0].w) : null;
  return `<div class="card" data-s="nu"><div class="card-h"><span class="tag">Body</span><div class="r"><button class="btn sm" data-act="checkin" data-d="${todayISO()}">Weigh in</button></div></div>
    <div class="stats"><div class="stat"><div class="k">Trend</div><div class="v">${last ? r1(last.avg) : "—"}<small>kg</small></div><div class="s">7-day average</div></div>
    <div class="stat"><div class="k">Change</div><div class="v ${change > 0 ? "warn" : ""}">${change != null ? (change > 0 ? "+" : "") + change : "—"}<small>kg</small></div><div class="s">since ${pts[0] ? fmtDay(pts[0].date, { day: "numeric", month: "short" }) : "start"}</div></div>
    <div class="stat"><div class="k">Target</div><div class="v">${p.target || "—"}<small>kg</small></div><div class="s">${t.weeks ? `~${t.weeks} weeks at ${t.rate} kg/wk` : "Hold it"}</div></div></div>
    ${tr.length >= 2 ? lineChart(tr.slice(-60).map(x => ({ x: x.date, a: x.w, b: x.avg })), { target: p.target, unit: "kg", c: "var(--nu)" }) : `<p class="muted" style="font-size:.86rem">Weigh in every morning. The trend line appears after two days. Daily weight jumps around; the 7-day trend is the truth.</p>`}</div>`;
}
function lineChart(rows, o = {}) {
  const W = 640, H = 300, pl = 58, pr = 12, pt = 16, pb = 38;
  const vals = rows.flatMap(r => [r.a, r.b]).concat(o.target ? [o.target] : []).filter(v => v != null);
  let lo = Math.min(...vals), hi = Math.max(...vals); if (hi - lo < 2) { hi += 1; lo -= 1; }
  const X = i => pl + (W - pl - pr) * (rows.length === 1 ? 0.5 : i / (rows.length - 1)), Y = v => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
  const path = k => { let started = false; return rows.map((r, i) => { if (r[k] == null) return ""; const c = `${started ? "L" : "M"}${X(i).toFixed(1)},${Y(r[k]).toFixed(1)}`; started = true; return c; }).join(""); };
  const ticks = [lo, (lo + hi) / 2, hi];
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || "chart")}">
    ${ticks.map(v => `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#1E1E21"/><text x="${pl - 10}" y="${Y(v) + 6}" fill="#94949A" font-size="19" text-anchor="end" font-family="JetBrains Mono,monospace">${Math.round(v * 10) / 10}</text>`).join("")}
    ${o.target ? `<line x1="${pl}" x2="${W - pr}" y1="${Y(o.target)}" y2="${Y(o.target)}" stroke="#FFFFFF" stroke-dasharray="4 5" opacity=".5"/><text x="${W - pr}" y="${Y(o.target) - 8}" fill="#D6D6D8" font-size="19" text-anchor="end" font-family="JetBrains Mono,monospace">target</text>` : ""}
    <path d="${path("a")}" fill="none" stroke="#55555B" stroke-width="2"/>
    ${rows.map((r, i) => r.a != null ? `<circle cx="${X(i)}" cy="${Y(r.a)}" r="4" fill="#55555B"/>` : "").join("")}
    <path d="${path("b")}" fill="none" stroke="${o.c || "#fff"}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round" style="stroke:${o.c || "#fff"}"/>
    <text x="${pl}" y="${H - 5}" fill="#94949A" font-size="19" font-family="JetBrains Mono,monospace">${esc(fmtDay(rows[0].x, { day: "numeric", month: "short" }))}</text>
    <text x="${W - pr}" y="${H - 5}" fill="#94949A" font-size="19" text-anchor="end" font-family="JetBrains Mono,monospace">${esc(fmtDay(rows[rows.length - 1].x, { day: "numeric", month: "short" }))}</text>
  </svg></div>`;
}

/* food adding: barcode (camera), search, quick add, recent */
function recentFoods() {
  const seen = new Map();
  Object.keys(S.days).sort().reverse().forEach(d => (S.days[d].food || []).forEach(f => { const k = (f.code || "") + "|" + f.name; if (!seen.has(k)) seen.set(k, f); }));
  return [...seen.values()].slice(0, 30);
}
function openFoodAdd(meal, date, tab = "scan") {
  S.fa = { meal, date, tab };
  const mealName = (MEALS.find(m => m[0] === meal) || [])[1];
  const tabs = [["scan", "Scan"], ["search", "Search"], ["recent", "Recent"], ["quick", "Quick add"]];
  let body = "";
  if (tab === "scan") body = `<div class="scan" id="scanBox"><video id="scanV" playsinline muted></video></div>
    <div class="muted" style="font-size:.84rem;text-align:center" id="scanMsg">Point the camera at the barcode.</div>
    <div class="row"><input type="text" id="bcIn" inputmode="numeric" placeholder="Or type the barcode number"><button class="btn" data-act="bc-look">Look up</button></div>`;
  if (tab === "search") body = `<form class="row" id="foodSearch"><input type="search" id="fsq" placeholder="e.g. Greek yoghurt" value="${esc(S.fsq || "")}" data-autofocus><button class="btn primary" type="submit">Search</button></form><div class="results" id="fsr"></div>`;
  if (tab === "recent") { const r = recentFoods(); body = r.length ? `<div class="results">${r.map((f, i) => `<button class="res" data-act="recent-add" data-i="${i}"><span>${esc(f.name)}<small>${f.g ? f.g + " g · " : ""}P ${Math.round(f.p || 0)} g</small></span><span class="mono">${Math.round(f.kcal)}</span></button>`).join("")}</div>` : `<p class="muted">Nothing logged yet.</p>`; }
  if (tab === "quick") body = `<form id="quickAdd" style="display:grid;gap:10px"><label class="f">What<input type="text" id="qa_n" required placeholder="e.g. Chicken wrap from the paddock"></label>
    <div class="grid2"><label class="f">Calories<input type="number" id="qa_k" inputmode="numeric" required></label><label class="f">Protein (g)<input type="number" id="qa_p" inputmode="decimal"></label>
    <label class="f">Carbs (g)<input type="number" id="qa_c" inputmode="decimal"></label><label class="f">Fat (g)<input type="number" id="qa_f" inputmode="decimal"></label></div>
    <button class="btn primary big" type="submit">Add to ${esc(mealName.toLowerCase())}</button></form>`;
  sheet(`<div class="card-h"><h2>Add to ${esc(mealName)}</h2><div class="r"><button class="btn sm ghost" data-act="sheet-close">Close</button></div></div>
    <div class="seg">${tabs.map(([k, n]) => `<button type="button" data-act="fa-tab" data-t="${k}" aria-pressed="${tab === k}">${n}</button>`).join("")}</div>
    <div class="seg">${MEALS.map(([k, n]) => `<button type="button" data-act="fa-meal" data-m="${k}" aria-pressed="${meal === k}">${n}</button>`).join("")}</div>${body}`);
  if (tab === "scan") startScan();
  if (tab === "search" && S.fsq) searchFood(S.fsq);
}
let scanStop = null;
async function startScan() {
  const v = $("#scanV"), msg = $("#scanMsg");
  const found = code => { stopScan(); beep(1200, 80); lookupBarcode(code); };
  try {
    if ("BarcodeDetector" in window) {
      const det = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      v.srcObject = stream; await v.play();
      let live = true; scanStop = () => { live = false; stream.getTracks().forEach(t => t.stop()); };
      const loop = async () => { if (!live) return; try { const c = await det.detect(v); if (c.length) return found(c[0].rawValue); } catch (e) {} requestAnimationFrame(loop); };
      loop(); return;
    }
    if (!window.ZXing) await loadScript("https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js");
    const reader = new ZXing.BrowserMultiFormatReader();
    scanStop = () => { try { reader.reset(); } catch (e) {} };
    await reader.decodeFromConstraints({ video: { facingMode: "environment" } }, v, (res) => { if (res) found(res.getText()); });
  } catch (e) {
    console.warn(e);
    if (msg) msg.innerHTML = /permission|notallowed/i.test(String(e && (e.name || e.message))) ? `<span class="warn">Camera blocked.</span> Allow camera access for this app in Settings, or type the number below.` : `<span class="warn">Camera unavailable here.</span> Type the barcode number below, or use Search.`;
  }
}
function stopScan() { if (scanStop) { try { scanStop(); } catch (e) {} scanStop = null; } }
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Load failed")); document.head.appendChild(s); }); }

const OFF = "https://world.openfoodfacts.org";
function offProduct(p, code) {
  const n = p.nutriments || {};
  const kcal100 = n["energy-kcal_100g"] ?? (n["energy_100g"] ? n["energy_100g"] / 4.184 : null);
  return { code: code || p.code, name: [p.brands && p.brands.split(",")[0], p.product_name || p.generic_name].filter(Boolean).join(" · ") || "Unnamed product",
    kcal100: kcal100 != null ? +kcal100 : null, p100: +(n.proteins_100g || 0), c100: +(n.carbohydrates_100g || 0), f100: +(n.fat_100g || 0), serving: parseFloat(p.serving_quantity) || null, servingLabel: p.serving_size || "" };
}
async function lookupBarcode(code) {
  code = String(code).replace(/\D/g, "");
  if (!code) return;
  const box = $("#sheet .in"); if (box) box.insertAdjacentHTML("beforeend", `<div class="muted" id="lkp">Looking up ${esc(code)}…</div>`);
  try {
    const r = await fetch(`${OFF}/api/v2/product/${code}.json?fields=code,product_name,generic_name,brands,nutriments,serving_size,serving_quantity`);
    const j = await r.json();
    if (!j || j.status !== 1 || !j.product) { const l = $("#lkp"); if (l) l.innerHTML = `<span class="warn">Not in the food database.</span> Use Quick add with the numbers off the label.`; return; }
    openAmount(offProduct(j.product, code));
  } catch (e) { const l = $("#lkp"); if (l) l.innerHTML = `<span class="warn">${esc(nice(e))}</span>`; }
}
async function searchFood(q) {
  S.fsq = q; const out = $("#fsr"); if (!out) return;
  out.innerHTML = `<div class="muted">Searching…</div>`;
  try {
    const r = await fetch(`${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=20&fields=code,product_name,generic_name,brands,nutriments,serving_size,serving_quantity`);
    const j = await r.json();
    S.fsr = (j.products || []).map(p => offProduct(p)).filter(p => p.kcal100 != null);
    out.innerHTML = S.fsr.length ? S.fsr.map((p, i) => `<button class="res" data-act="fs-pick" data-i="${i}"><span>${esc(p.name)}<small>per 100 g · P ${r1(p.p100)} · C ${r1(p.c100)} · F ${r1(p.f100)}</small></span><span class="mono">${Math.round(p.kcal100)}</span></button>`).join("") : `<div class="muted">Nothing found. Try fewer words, or Quick add.</div>`;
  } catch (e) { out.innerHTML = `<div class="warn">${esc(nice(e))}</div>`; }
}
function openAmount(prod) {
  S.prod = prod;
  const g = prod.serving || 100;
  sheet(`<h2>${esc(prod.name)}</h2>
    ${prod.kcal100 == null ? `<p class="warn">No calories on file for this one. Use Quick add with the label numbers.</p>` : `
    <div class="muted" style="font-size:.84rem">Per 100 g: ${Math.round(prod.kcal100)} kcal · P ${r1(prod.p100)} · C ${r1(prod.c100)} · F ${r1(prod.f100)}${prod.servingLabel ? ` · serving ${esc(prod.servingLabel)}` : ""}</div>
    <label class="f">Amount (g)<input type="number" id="amt" inputmode="decimal" value="${g}" data-autofocus></label>
    <div class="seg">${[prod.serving, 50, 100, 150, 200].filter((v, i, a) => v && a.indexOf(v) === i).map(v => `<button type="button" data-act="amt" data-v="${v}">${v === prod.serving ? "1 serving" : v + " g"}</button>`).join("")}</div>
    <div class="stats" id="amtOut"></div>
    <div class="seg">${MEALS.map(([k, n]) => `<button type="button" data-act="fa-meal2" data-m="${k}" aria-pressed="${S.fa.meal === k}">${n}</button>`).join("")}</div>
    <button class="btn primary big" data-act="amt-add">Add</button>`}
    <button class="btn ghost" data-act="fa-back">Back</button>`);
  amtCalc();
}
function amtCalc() {
  const p = S.prod, g = +($("#amt") || {}).value || 0, f = g / 100, o = $("#amtOut"); if (!o || p.kcal100 == null) return;
  S.amtItem = { name: p.name, code: p.code, g, kcal: Math.round(p.kcal100 * f), p: r1(p.p100 * f), c: r1(p.c100 * f), f: r1(p.f100 * f) };
  o.innerHTML = [["kcal", S.amtItem.kcal], ["Protein", S.amtItem.p + "g"], ["Carbs", S.amtItem.c + "g"], ["Fat", S.amtItem.f + "g"]].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v" style="font-size:1rem">${v}</div></div>`).join("");
}
function addFood(item) {
  const { meal, date } = S.fa, d = D(date);
  d.food = [...(d.food || []), { ...item, meal, t: Date.now() }];
  touch(date); closeSheet(); S.keepScroll = window.scrollY; render(); toast(`Added · ${Math.round(item.kcal)} kcal`);
}

/* ---------- RECOVER ---------- */
function viewRecover() {
  const days = Array.from({ length: 21 }, (_, i) => addDays(todayISO(), i - 20));
  const rows = days.map(d => ({ x: d, a: S.oura[d] ? S.oura[d].sleep_score : null, b: S.oura[d] ? S.oura[d].readiness : null }));
  const hasO = rows.some(r => r.a != null || r.b != null);
  const acts = S.acts.slice(0, 12);
  const link = (k, name, what) => {
    const on = !!S.links[k];
    return `<div class="blk"><div class="row"><b>${name}</b><span class="chip ${on ? "ok" : ""}" style="margin-left:auto">${on ? "Connected" : "Not connected"}</span></div><div class="cue">${what}</div>
      <div class="row">${on ? `<button class="btn sm" data-act="wsync">Sync now</button><button class="btn sm ghost" data-act="unlink" data-p="${k}">Disconnect</button>` : S.mode === "local" ? `<span class="muted" style="font-size:.82rem">Sign in from Settings to connect.</span>` : `<button class="btn sm primary" data-act="link" data-p="${k}">Connect ${name.split(" ")[0]}</button>`}</div></div>`;
  };
  const ph = FX.phase(todayISO(), P());
  return `${readinessCard(todayISO(), true)}
    <div class="card" data-s="rc"><div class="card-h"><span class="tag">Last 3 weeks</span><div class="r"><span class="chip" style="color:var(--rc)">Readiness</span><span class="chip" style="color:#94949A">Sleep</span></div></div>
      ${hasO ? lineChart(rows.map(r => ({ x: r.x, a: r.a, b: r.b })), { c: "var(--rc)", label: "Readiness and sleep" }) : `<p class="muted" style="font-size:.86rem">Your Oura readiness and sleep scores chart here once connected.</p>`}</div>
    <div class="card" data-s="rc"><div class="card-h"><span class="tag">Wearables</span></div>
      ${link("oura", "Oura Ring", "Sleep, readiness, HRV, resting HR and temperature. Drives the illness guard.")}
      ${link("strava", "Garmin (via Strava)", "Garmin Connect auto-uploads to Strava; the app reads it from there and verifies your sessions.")}
      ${S.links.strava ? "" : `<details><summary class="muted" style="font-size:.84rem">Link Garmin to Strava</summary><ol class="howto" style="margin-top:8px"><li>Open <b>Garmin Connect</b> → More → Settings → Connected Apps.</li><li>Add <b>Strava</b> and allow activity upload.</li><li>Come back here and tap <b>Connect Garmin</b>.</li></ol></details>`}
    </div>
    <div class="card" data-s="rc"><div class="card-h"><span class="tag">The illness guard</span></div>
      <p class="soft" style="font-size:.9rem">Every morning the app reads your night. Amber trims the session. Red swaps it for recovery: no cardio, and it still counts as done.</p>
      <div class="stats"><div class="stat"><div class="k" style="color:var(--bad)">Red</div><div class="s">Readiness under 55, sleep under 55, temp +0.5 °C, resting HR +7, or you report being ill</div></div>
      <div class="stat"><div class="k" style="color:var(--warn)">Amber</div><div class="s">Readiness 55–69, sleep 55–69, resting HR +4, feeling flat or very sore</div></div></div></div>
    ${ph.heat ? `<div class="card" data-s="heat"><div class="card-h"><span class="tag" style="color:var(--heat)">Heat acclimation</span></div><p class="soft" style="font-size:.9rem">${esc(ph.event.name)} in ${diffDays(todayISO(), ph.event.from)} days. After every easy or long run: 30–40 min hot bath or sauna, or train in extra layers. 10–14 days of this adapts your sweat rate and core temperature.</p></div>` : ""}
    <div class="card" data-s="tr"><div class="card-h"><span class="tag">Garmin activities</span></div>
      ${acts.length ? acts.map(a => `<div class="fi"><div class="n">${esc(a.name || a.sport)}<small>${esc(fmtDay(a.date))} · ${esc(a.sport)}${a.dist_m ? ` · ${r1(a.dist_m / 1000)} km` : ""}${a.avg_hr ? ` · ${Math.round(a.avg_hr)} bpm` : ""}</small></div><span class="k">${fmtMin(Math.round((a.dur_s || 0) / 60))}</span><span></span></div>`).join("") : `<p class="muted" style="font-size:.86rem">No activities yet.</p>`}</div>`;
}
async function linkProvider(p) {
  if (!sb || !S.user) return toast("Sign in first, from Settings.");
  try {
    const ret = location.href.split("#")[0] + "#/rec";
    const { data, error } = await sb.functions.invoke("fx-sync", { body: { action: "auth", provider: p, ret } });
    if (error) { let m = error.message; try { const j = await error.context.json(); m = j.error || m; } catch (e) {} throw new Error(m); }
    location.href = data.url;
  } catch (e) { toast(nice(e), 4500); }
}

/* ---------- SCORE ---------- */
function ring(v, size = 150) {
  const r = 64, c = 2 * Math.PI * r, f = v == null ? 0 : v / 100;
  const col = v == null ? "#34343A" : v >= 80 ? "#FFFFFF" : v >= 60 ? "#FFB23F" : "#FF5A4E";
  return `<div class="ring"><svg viewBox="0 0 150 150"><circle cx="75" cy="75" r="${r}" stroke="#1E1E21" stroke-width="10" fill="none"/><circle cx="75" cy="75" r="${r}" stroke="${col}" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}"/></svg><div class="v">${v ?? "—"}<small>/ 100</small></div></div>`;
}
function viewScore(mon) {
  const p = P(), cur = monday(todayISO());
  mon = mon && /^\d{4}-\d{2}-\d{2}$/.test(mon) ? monday(mon) : cur;
  const sc = FX.weekScore(mon, ctx());
  const names = { training: ["Training", "var(--tr)"], nutrition: ["Nutrition", "var(--nu)"], recovery: ["Sleep + hydration", "var(--rc)"], checkin: ["Check-in + weigh-in", "var(--sc)"], cognitive: ["Reactions", "var(--cg)"] };
  const parts = Object.entries(sc.parts).map(([k, v]) => { const pct = 100 * v.pts / v.max; return `<div class="part" style="--c:${names[k][1]}"><div class="l"><i></i>${names[k][0]}</div><div class="p ${pct < 50 ? "bad" : pct < 75 ? "warn" : ""}">${Math.round(v.pts)}<span class="muted" style="font-size:.7em"> / ${v.max}</span></div><div class="bar" style="--c:${names[k][1]}"><i style="width:${pct}%"></i></div><div class="d">${esc(v.detail)}</div></div>`; }).join("");
  const hist = [];
  for (let m = cur; m >= monday(p.start || cur) && hist.length < 26; m = addDays(m, -7)) { const s = FX.weekScore(m, ctx()); if (s.total != null) hist.push([m, s]); }
  const logRows = sc.log.map(l => `<div class="fi"><div class="n">${esc(l.title)}<small>${esc(fmtDay(l.date))}${l.moved ? " · moved in" : ""}${l.adapted ? ` · ${l.adapted === "red" ? "recovery swap" : "trimmed"}` : ""}</small></div><span class="chip ${l.how === "verified" || l.how === "protected" ? "ok" : l.how === "missed" ? "bad" : ""}">${l.how}</span><span class="k">${Math.round(l.c * 100)}%</span></div>`).join("");
  return `<div class="card" data-s="sc">
      <div class="card-h"><a class="iconbtn" href="#/score/${addDays(mon, -7)}" aria-label="Previous week">${I.back}</a><div style="flex:1;text-align:center"><div class="eyebrow">${mon === cur ? "This week so far" : "Week report"}</div><b>${fmtDay(mon, { day: "numeric", month: "short" })} – ${fmtDay(addDays(mon, 6), { day: "numeric", month: "short" })}</b></div>${mon < cur ? `<a class="iconbtn" href="#/score/${addDays(mon, 7)}" style="transform:scaleX(-1)" aria-label="Next week">${I.back}</a>` : `<span style="width:36px"></span>`}</div>
      ${ring(sc.total)}<div style="text-align:center" class="coach">${esc(FX.grade(sc.total) || "Not started")}<small>${sc.total == null ? "The week hasn't started yet." : mon === cur ? `${sc.days} of 7 days in. ${sc.total >= 80 ? "Keep the standard." : "Plenty of week left to fix it."}` : sc.total >= 90 ? "Podium week. That's the level." : sc.total >= 80 ? "Solid. Find the last 10%." : sc.total >= 65 ? "Midfield. Not good enough for you." : "That week cost you. Reset Monday."}</small></div>
    </div>
    ${sc.total != null ? `<div class="card" data-s="sc"><div class="card-h"><span class="tag">Breakdown</span></div><div>${parts}</div></div>` : ""}
    ${sc.fixes.length ? `<div class="card" data-s="sc"><div class="card-h"><span class="tag">${mon === cur ? "Fix it this week" : "Fix it next week"}</span></div>${sc.fixes.map((f, i) => `<div class="fix"><span>0${i + 1}</span><div>${esc(f)}</div></div>`).join("")}</div>` : ""}
    ${logRows ? `<div class="card" data-s="tr"><div class="card-h"><span class="tag">Session log</span></div>${logRows}<div class="muted" style="font-size:.78rem">Verified by Garmin 100% · self-reported 70% · moved 85% of that · recovery swap done 100%</div></div>` : ""}
    ${hist.length > 1 ? `<div class="card"><div class="card-h"><span class="tag">History</span></div>${hist.map(([m, s]) => `<a class="hist" href="#/score/${m}" style="text-decoration:none;color:inherit"><span>${fmtDay(m, { day: "numeric", month: "short" })}${m === cur ? " · now" : ""}</span><span class="muted" style="font-size:.8rem">${esc(FX.grade(s.total))}</span><span class="s ${s.total < 50 ? "bad" : s.total < 65 ? "warn" : ""}">${s.total}</span></a>`).join("")}</div>` : ""}`;
}

/* ---------- ME / settings ---------- */
function viewMe() {
  const p = S.profile, t = FX.targets(P(), lastWeight(), true), L = FX.levels(P()), pc = FX.paces(L), z = FX.zones(L), b = p.baseline || {};
  return `<div class="card"><div class="card-h"><span class="tag">Driver</span><div class="r"><span class="chip">${S.user ? esc(S.user.email.split("@")[0]) : "This device only"}</span></div></div>
      <form id="meForm" style="display:grid;gap:10px">
      <div class="grid2"><label class="f">First name<input type="text" id="m_name" value="${esc(p.name || "")}"></label><label class="f">Date of birth<input type="date" id="m_dob" value="${esc(p.dob || "")}"></label></div>
      <div class="grid3"><label class="f">Height (cm)<input type="number" id="m_h" step="0.5" value="${esc(p.height || "")}"></label><label class="f">Start weight<input type="number" id="m_w" step="0.1" value="${esc(p.weight || "")}"></label><label class="f">Target (kg)<input type="number" id="m_t" step="0.1" value="${esc(p.target || "")}"></label></div>
      <div class="grid2"><label class="f">Max HR<input type="number" id="m_hr" value="${esc(p.hrMax || "")}" placeholder="${L.hrMax} est."></label><label class="f">Pull-up bar<select id="m_bar"><option value="0">No</option><option value="1" ${p.hasBar ? "selected" : ""}>Yes</option></select></label></div>
      <button class="btn primary" type="submit">Save</button></form></div>
    <div class="card" data-s="nu"><div class="card-h"><span class="tag">Daily targets</span></div>
      <div class="stats"><div class="stat"><div class="k">Calories</div><div class="v">${t.kcal}</div></div><div class="stat"><div class="k">Protein</div><div class="v">${t.protein}<small>g</small></div></div><div class="stat"><div class="k">Carbs</div><div class="v">${t.carbs}<small>g</small></div></div><div class="stat"><div class="k">Fat</div><div class="v">${t.fat}<small>g</small></div></div><div class="stat"><div class="k">Water</div><div class="v">${r1(t.water / 1000)}<small>L</small></div></div></div>
      <p class="muted" style="font-size:.82rem">Maintenance about ${t.tdee} kcal. ${t.rate ? `Losing ${t.rate} kg a week, so you keep power and don't get run down.` : "At target: eating to hold it."}</p></div>
    <div class="card" data-s="tr"><div class="card-h"><span class="tag">Your numbers</span><div class="r"><button class="btn sm" data-act="retest">Retest today</button></div></div>
      ${b.done ? `<div class="stats"><div class="stat"><div class="k">5 km</div><div class="v">${b.run5k ? mmss(b.run5k) : "—"}</div></div><div class="stat"><div class="k">Push-ups</div><div class="v">${b.pushups ?? "—"}</div></div><div class="stat"><div class="k">Pull-ups</div><div class="v">${b.pullups ?? "—"}</div></div><div class="stat"><div class="k">Plank</div><div class="v">${b.plank ?? "—"}<small>s</small></div></div><div class="stat"><div class="k">Wall sit</div><div class="v">${b.wallsit ?? "—"}<small>s</small></div></div><div class="stat"><div class="k">Reaction</div><div class="v">${b.reaction ?? "—"}<small>ms</small></div></div></div>` : `<p class="muted" style="font-size:.86rem">Baseline test on ${esc(fmtDay(p.start))}. Until then the plan uses safe defaults.</p>`}
      <div class="stats"><div class="stat"><div class="k">Easy</div><div class="v" style="font-size:.9rem">${pc.easy}</div><div class="s">${z.z2}</div></div><div class="stat"><div class="k">Tempo</div><div class="v" style="font-size:.9rem">${pc.tempo}</div><div class="s">${z.z3}</div></div><div class="stat"><div class="k">Hard</div><div class="v" style="font-size:.9rem">${pc.hard}</div><div class="s">${z.z4}</div></div></div>
      <p class="muted" style="font-size:.8rem">Retest every 8 weeks. The plan recalibrates to the new numbers.</p></div>
    <div class="card"><div class="card-h"><span class="tag">Morning call</span></div>
      <div class="grid2"><label class="f">Mon–Fri<input type="time" id="m_wd" value="${esc(p.notifyWd || "07:00")}"></label><label class="f">Sat–Sun<input type="time" id="m_we" value="${esc(p.notifyWe || "08:30")}"></label></div>
      <div class="muted" style="font-size:.8rem">Local time wherever you are. Travelling to a round? It follows your phone's time zone.</div>
      <button class="btn" data-act="save-times">Save times</button></div>
    ${pushCard(true)}
    <div class="card"><div class="card-h"><span class="tag">Account</span></div>
      ${S.user ? `<div class="row"><button class="btn grow" data-act="export">Export my data</button><button class="btn grow" data-act="signout">Sign out</button></div>` : `<p class="muted" style="font-size:.86rem">You're on this device only. Sign in to sync with your iPad and connect Oura and Garmin. Everything you've logged comes with you.</p><button class="btn primary" data-act="to-login">Sign in</button><button class="btn" data-act="export">Export my data</button>`}
    </div><div class="eyebrow" style="text-align:center;padding:8px 0">VCASO PERFORMANCE · FITNESS · v1</div>`;
}

/* ---------- push (morning call) ---------- */
const PUSH = { state: null, reg: null, busy: false };
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function b64u(k) { const p = "=".repeat((4 - k.length % 4) % 4), r = atob((k + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); }
async function saveSub(sub) { if (!sb || !S.user) return false; const { error } = await sb.from("fx_push_subs").upsert({ user_id: S.user.id, endpoint: sub.endpoint, sub: sub.toJSON(), ua: navigator.userAgent.slice(0, 200) }, { onConflict: "endpoint" }); if (error) console.warn(error); return !error; }
async function pushInit() {
  if (!("serviceWorker" in navigator)) { PUSH.state = "nosupport"; return; }
  try { PUSH.reg = await navigator.serviceWorker.register("sw.js"); } catch (e) { PUSH.state = "nosupport"; return; }
  if (!S.user) { PUSH.state = "local"; return; }
  if (!("PushManager" in window) || !("Notification" in window)) { PUSH.state = isIOS() && !isStandalone() ? "install" : "nosupport"; return; }
  if (Notification.permission === "denied") { PUSH.state = "denied"; return; }
  const sub = await PUSH.reg.pushManager.getSubscription().catch(() => null);
  if (sub && Notification.permission === "granted") { PUSH.state = "on"; saveSub(sub); } else PUSH.state = "off";
}
async function pushOn() {
  if (PUSH.busy) return; PUSH.busy = true; render();
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { PUSH.state = perm === "denied" ? "denied" : "off"; return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(CFG.vapid) });
    if (!await saveSub(sub)) { toast("Couldn't save. Check signal and try again."); return; }
    PUSH.state = "on"; await sb.functions.invoke("fx-remind", { body: { test: true } }); toast("Morning call on. A test is on its way.");
  } catch (e) { console.warn(e); toast(nice(e)); }
  finally { PUSH.busy = false; render(); }
}
function pushCard(always) {
  const st = PUSH.state; if (!st || st === "nosupport" || st === "local") return "";
  const p = S.profile || {};
  const who = `Every morning at ${p.notifyWd || "07:00"} (weekends ${p.notifyWe || "08:30"}): today's session, your readiness, and last week's score on Mondays.`;
  if (st === "on") return always ? `<div class="card"><div class="card-h"><span class="tag">Notifications</span><div class="r"><span class="chip ok">On</span><button class="btn sm" data-act="push-test">Send a test</button></div></div><p class="muted" style="font-size:.86rem">${who}</p></div>` : "";
  if (st === "install") return `<div class="card"><div class="card-h"><span class="tag">Morning call</span><span class="chip warn">Not on yet</span></div><p class="muted" style="font-size:.88rem">${who}</p>
    <ol class="howto"><li>Tap <b>Share</b> at the bottom of Safari.</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open <b>VCASO Fitness</b> from the new icon and tap <b>Turn on</b>.</li></ol></div>`;
  if (st === "denied") return `<div class="card"><div class="card-h"><span class="tag">Morning call</span><span class="chip bad">Blocked</span></div><p class="muted" style="font-size:.88rem">Notifications are off for VCASO Fitness. Open <b>Settings → Notifications → VCASO Fitness</b>, allow them, then come back.</p></div>`;
  return `<div class="card"><div class="card-h"><span class="tag">Morning call</span><span class="chip warn">Off</span></div><p class="muted" style="font-size:.88rem">${who}</p><button class="btn primary big" data-act="push-on" ${PUSH.busy ? "disabled" : ""}>${PUSH.busy ? "Turning on…" : "Turn on"}</button></div>`;
}

/* ---------- events ---------- */
document.addEventListener("click", async ev => {
  const go = ev.target.closest("[data-go]"); if (go) { location.hash = go.dataset.go; return; }
  const el = ev.target.closest("[data-act]"); if (!el) return;
  const a = el.dataset.act, d = el.dataset.d;
  switch (a) {
    case "home": location.hash = "#/"; if (!S.route.length) render(); break;
    case "local": S.mode = "local"; ls.set("mode", "local"); route(); pushInit(); break;
    case "to-login": S.mode = null; ls.set("mode", null); route(); break;
    case "ob-back": S.ob.step = Math.max(1, S.ob.step - 1); viewOnboard(); break;
    case "checkin": openCheckin(d); break;
    case "ci-save": saveCheckin(d); break;
    case "done": markDone(d, { via: "tap" }); toast(sessionOn(d).v ? "Verified." : "Logged. It verifies when Garmin syncs."); S.keepScroll = scrollY; render(); syncWearables(true); break;
    case "undo": { const x = D(d); delete x.s; touch(d); render(); break; }
    case "move": moveSession(d); break;
    case "override": D(d).override = true; touch(d); S.keepScroll = scrollY; render(); break;
    case "wsync": syncWearables(true); break;
    case "link": linkProvider(el.dataset.p); break;
    case "unlink": if (confirm("Disconnect? Past data stays.")) { try { await sb.functions.invoke("fx-sync", { body: { action: "unlink", provider: el.dataset.p } }); delete S.links[el.dataset.p]; ls.set("links", S.links); render(); } catch (e) { toast(nice(e)); } } break;
    case "push-on": pushOn(); break;
    case "push-test": try { await sb.functions.invoke("fx-remind", { body: { test: true } }); toast("Test sent."); } catch (e) { toast(nice(e)); } break;
    case "save-times": S.profile.notifyWd = $("#m_wd").value; S.profile.notifyWe = $("#m_we").value; touch(); toast("Saved."); break;
    case "retest": if (confirm("Swap today's session for the baseline test?")) { S.profile.testDays = [...new Set([...(S.profile.testDays || []), todayISO()])]; touch(); touch(todayISO()); location.hash = "#/"; } break;
    case "signout": if (sb) await sb.auth.signOut(); S.user = null; S.mode = null; ls.set("mode", null); route(); break;
    case "export": { const blob = new Blob([JSON.stringify({ profile: S.profile, days: S.days, activities: S.acts, oura: S.oura }, null, 1)], { type: "application/json" }); const u = URL.createObjectURL(blob); const l = document.createElement("a"); l.href = u; l.download = `vcaso-fitness-${todayISO()}.json`; l.click(); setTimeout(() => URL.revokeObjectURL(u), 2000); break; }
    case "add-event": addEvent(); break;
    case "sheet-close": closeSheet(); break;
    // player
    case "p-quit": if (confirm("End the session? Progress isn't saved unless you finish.")) { S.player = null; stopPlayer(); location.hash = "#/"; } break;
    case "p-next": nextStep(); break;
    case "p-pause": { const P_ = S.player; P_.paused = !P_.paused; if (P_.runStart) { if (P_.paused) P_.pauseAt = Date.now(); else P_.pausedMs = (P_.pausedMs || 0) + (Date.now() - P_.pauseAt); } el.textContent = P_.paused ? "Resume" : "Pause"; break; }
    case "p-runstart": S.player.runStart = Date.now(); beep(1100, 180, 2); drawStep(); break;
    case "p-test": { const st = S.player.steps[S.player.i], raw = $("#tv").value.trim(); let v = null;
      if (st.run) { const m = raw.match(/^(\d{1,2})[:.](\d{2})$/); v = m ? +m[1] * 60 + +m[2] : null; } else v = raw === "" ? null : +raw;
      if (v == null || isNaN(v)) return toast(st.run ? "Enter the time as mm:ss, e.g. 27:30" : "Enter a number");
      S.player.test[st.id] = v; S.player.sw = null; nextStep(); break; }
    case "p-stopwatch": { const P_ = S.player; if (!P_.sw) { P_.sw = Date.now(); beep(1100, 150); el.textContent = "Stop"; P_.swT = setInterval(() => { const c = $("#sw"); if (c) c.textContent = mmss((Date.now() - P_.sw) / 1000); }, 250); } else { clearInterval(P_.swT); const s = Math.round((Date.now() - P_.sw) / 1000); $("#tv").value = s; P_.sw = null; el.textContent = "Start stopwatch"; beep(660, 200, 2); } break; }
    case "p-save": savePlayer(); break;
    case "drill-again": viewDrill(el.dataset.k); break;
    // food
    case "food-add": openFoodAdd(el.dataset.m, d); break;
    case "fa-tab": stopScan(); openFoodAdd(S.fa.meal, S.fa.date, el.dataset.t); break;
    case "fa-meal": stopScan(); openFoodAdd(el.dataset.m, S.fa.date, S.fa.tab); break;
    case "fa-meal2": S.fa.meal = el.dataset.m; el.parentElement.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b === el)); break;
    case "fa-back": openFoodAdd(S.fa.meal, S.fa.date, S.fa.tab === "scan" ? "search" : S.fa.tab); break;
    case "bc-look": lookupBarcode($("#bcIn").value); break;
    case "fs-pick": openAmount(S.fsr[+el.dataset.i]); break;
    case "amt": $("#amt").value = el.dataset.v; amtCalc(); break;
    case "amt-add": amtCalc(); if (!S.amtItem.g) return toast("Enter an amount"); addFood(S.amtItem); break;
    case "recent-add": { const f = recentFoods()[+el.dataset.i]; const { meal: _m, t: _t, ...rest } = f; addFood(rest); break; }
    case "food-del": { const x = D(d); x.food.splice(+el.dataset.i, 1); touch(d); S.keepScroll = scrollY; render(); break; }
    case "food-repeat": { const y = (S.days[addDays(d, -1)] || {}).food || [], x = D(d); x.food = [...(x.food || []), ...y.filter(f => f.meal === el.dataset.m).map(f => ({ ...f, t: Date.now() }))]; touch(d); S.keepScroll = scrollY; render(); toast("Repeated."); break; }
    case "water": { const x = D(d); x.water = Math.max(0, (x.water || 0) + +el.dataset.v); touch(d); S.keepScroll = scrollY; render(); break; }
  }
  // segmented controls
});
document.addEventListener("click", ev => {
  const b = ev.target.closest(".seg[data-seg] button, .seg[data-ci] button, #rpe button"); if (!b) return;
  const seg = b.parentElement;
  seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b));
  if (seg.dataset.seg === "hasBar") S.ob.hasBar = b.dataset.v === "1";
  if (seg.dataset.ci) S.ciDraft[seg.dataset.ci] = +b.dataset.v;
});
document.addEventListener("input", ev => { if (ev.target.id === "amt") amtCalc(); });
document.addEventListener("submit", ev => {
  ev.preventDefault(); const id = ev.target.id;
  if (id === "loginForm") return doLogin(ev.target);
  if (/^ob\d$/.test(id)) return obSubmit(id);
  if (id === "foodSearch") return searchFood($("#fsq").value.trim());
  if (id === "quickAdd") return addFood({ name: $("#qa_n").value.trim(), kcal: +$("#qa_k").value || 0, p: +$("#qa_p").value || 0, c: +$("#qa_c").value || 0, f: +$("#qa_f").value || 0 });
  if (id === "meForm") { Object.assign(S.profile, { name: $("#m_name").value.trim(), dob: $("#m_dob").value, height: +$("#m_h").value, weight: +$("#m_w").value, target: +$("#m_t").value, hrMax: +$("#m_hr").value || null, hasBar: $("#m_bar").value === "1" }); touch(); toast("Saved. Plan and targets updated."); render(); }
  if (id === "evForm") { const e = { name: $("#ev_n").value.trim(), from: $("#ev_f").value, to: $("#ev_t").value || $("#ev_f").value, note: "Your event" }; if (!e.name || !e.from) return; S.profile.events = [...(S.profile.events || []), e]; touch(); closeSheet(); render(); toast("Added. The plan tapers into it."); }
});
function addEvent() {
  sheet(`<h2>Add a test or event</h2><p class="muted" style="font-size:.86rem">Pre-season tests, sim days, anything you need to be sharp for. The plan tapers into it like a race weekend.</p>
    <form id="evForm" style="display:grid;gap:10px"><label class="f">Name<input type="text" id="ev_n" required placeholder="e.g. Pre-season test, Bahrain"></label>
    <div class="grid2"><label class="f">From<input type="date" id="ev_f" required></label><label class="f">To<input type="date" id="ev_t"></label></div>
    <button class="btn primary big" type="submit">Add</button></form>
    ${(S.profile.events || []).length ? `<div>${S.profile.events.map(e => `<div class="fi"><div class="n">${esc(e.name)}<small>${esc(fmtDay(e.from))}</small></div><span></span><span></span></div>`).join("")}</div>` : ""}`);
}
window.addEventListener("online", () => { flush(); syncWearables(); render(); });
window.addEventListener("offline", () => setSync("Offline", ""));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.user) { syncWearables(); if (!S.player && !$("#sheet")) render(); } });

/* completed weeks' scores go up with the profile, so Monday's morning call can quote last week */
function storeScores() {
  const p = S.profile; if (!p || !p.start) return;
  const cur = monday(todayISO()); const sc = { ...(p.scores || {}) }; let ch = false;
  for (let m = addDays(cur, -7); m >= monday(p.start) && m >= addDays(cur, -56); m = addDays(m, -7)) {
    const t = FX.weekScore(m, ctx()).total; if (t != null && sc[m] !== t) { sc[m] = t; ch = true; }
  }
  if (ch) { p.scores = sc; touch(); }
}

/* ---------- boot ---------- */
async function boot() {
  // came back from Oura / Strava?
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  if (q.get("linked")) setTimeout(() => toast(`${q.get("linked") === "oura" ? "Oura" : "Garmin via Strava"} connected. Pulling your data.`), 300);
  if (q.get("link_error")) setTimeout(() => toast("Connection failed: " + q.get("link_error"), 5000), 300);
  if (sb && S.mode !== "local") {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session) { S.user = session.user; S.mode = "cloud"; ls.set("mode", "cloud"); }
      else if (S.mode === "cloud") { S.mode = null; }
    } catch (e) { console.warn(e); }
  }
  if (!sb && S.mode === "cloud") S.mode = "local-fallback";
  if (S.mode === "local-fallback") S.mode = "local";
  route();
  if (S.user) {
    try { await loadCloud(); storeScores(); await flush(); route(); pushTitles(); syncWearables(!!q.get("linked")); } catch (e) { console.warn(e); setSync("Offline · saved on phone", "bad"); }
  }
  if (S.profile) storeScores();
  pushInit().then(() => { if (!S.player && !$("#sheet")) render(); });
}
boot();
