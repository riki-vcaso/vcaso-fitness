/* VCASO Fitness · programme engine
   Pure functions: calendar, phases, daily sessions, adaptation, verification, nutrition targets, weekly score.
   No DOM in here, so it can be tested on its own (node test/engine.test.cjs). */
(function (root) {
"use strict";

/* ---------- dates (local YYYY-MM-DD strings) ---------- */
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const dow = s => (parse(s).getDay() + 6) % 7;            // Mon 0 … Sun 6
const monday = s => addDays(s, -dow(s));
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const todayISO = () => iso(new Date());

/* ---------- FIA F3 2027 ----------
   Ten rounds, all on F1 weekends. Dates are the F1 weekend dates, so they are provisional
   until the FIA publishes the F3 timetable. hot: heat acclimation block before it. */
const SEASON = 2027;
const F3 = [
  { r: 1, name: "Bahrain",     circuit: "Bahrain International Circuit", from: "2027-03-12", to: "2027-03-14", hot: true },
  { r: 2, name: "Saudi Arabia",circuit: "Jeddah Corniche Circuit",       from: "2027-03-19", to: "2027-03-21", hot: true },
  { r: 3, name: "Australia",   circuit: "Albert Park",                   from: "2027-04-02", to: "2027-04-04" },
  { r: 4, name: "Canada",      circuit: "Circuit Gilles Villeneuve",     from: "2027-05-21", to: "2027-05-23" },
  { r: 5, name: "Monaco",      circuit: "Circuit de Monaco",             from: "2027-06-04", to: "2027-06-06" },
  { r: 6, name: "Great Britain",circuit: "Silverstone",                  from: "2027-07-02", to: "2027-07-04" },
  { r: 7, name: "Austria",     circuit: "Red Bull Ring",                 from: "2027-07-09", to: "2027-07-11" },
  { r: 8, name: "Italy",       circuit: "Monza",                         from: "2027-09-03", to: "2027-09-05" },
  { r: 9, name: "Spain",       circuit: "Madring, Madrid",               from: "2027-09-10", to: "2027-09-12", hot: true },
  { r: 10, name: "Türkiye",    circuit: "Istanbul",                      from: "2027-10-01", to: "2027-10-03" },
];

function events(profile) {
  const extra = ((profile && profile.events) || []).map(e => ({ ...e, custom: true }));
  return [...F3, ...extra].sort((a, b) => a.from.localeCompare(b.from));
}
function nextEvent(date, profile) { return events(profile).find(e => e.to >= date) || null; }

/* ---------- phases ---------- */
const PROG_START = "2026-11-09";                         // first Monday of the programme
function phase(date, profile) {
  const ev = events(profile);
  // race weekend: Thursday travel day through Sunday
  for (const e of ev) {
    const thu = addDays(e.from, -1);
    if (date >= thu && date <= e.to) return { id: "race", label: "Race weekend", event: e, day: diffDays(thu, date) };
    if (date === addDays(e.to, 1)) return { id: "post", label: "Post-race recovery", event: e };
  }
  const nx = ev.find(e => e.from > date);
  const prev = [...ev].reverse().find(e => e.to < date);
  if (nx && diffDays(date, nx.from) <= 4) return { id: "taper", label: "Race week", event: nx, back2back: prev && diffDays(prev.to, nx.from) <= 6 };
  const heat = nx && nx.hot && diffDays(date, nx.from) <= 14;
  if (date < "2027-01-04") return { id: "base", label: "Off-season base", heat, event: nx };
  if (date < "2027-02-22") return { id: "build", label: "Off-season build", heat, event: nx };
  if (date < F3[0].from) return { id: "peak", label: "Pre-season sharpen", heat, event: nx };
  if (date > F3[F3.length - 1].to) {
    if (diffDays(F3[F3.length - 1].to, date) <= 14) return { id: "reset", label: "Season reset", event: nx };
    return { id: "base", label: "Off-season base", event: nx };
  }
  const gap = prev && nx ? diffDays(prev.to, nx.from) : 0;
  if (gap >= 35) return { id: "build", label: "Mid-season build", heat, event: nx };
  return { id: "maintain", label: "In-season maintain", heat, event: nx };
}

// every fourth week is lighter (not race weeks)
function weekIndex(date) { return Math.max(0, Math.floor(diffDays(PROG_START, monday(date)) / 7)); }
function load(date) { const w = weekIndex(date) % 4; return w === 3 ? 0.7 : [1, 1.08, 1.15][w]; }
const isDeload = date => weekIndex(date) % 4 === 3;

/* ---------- levels from the baseline test ---------- */
function levels(profile) {
  const b = (profile && profile.baseline) || {};
  const run5k = b.run5k || 0;                              // seconds
  const p5 = run5k ? run5k / 5 : 375;                      // s per km at 5k effort (6:15 default until tested)
  const push = b.pushups ?? 15, pull = b.pullups ?? 0, plank = b.plank ?? 60, wall = b.wallsit ?? 60;
  const up = push >= 40 ? 3 : push >= 22 ? 2 : push >= 10 ? 1 : 0;
  const core = plank >= 150 ? 3 : plank >= 90 ? 2 : plank >= 45 ? 1 : 0;
  const leg = wall >= 150 ? 3 : wall >= 90 ? 2 : wall >= 45 ? 1 : 0;
  const run = p5 <= 240 ? 3 : p5 <= 290 ? 2 : p5 <= 340 ? 1 : 0;
  const age = profile && profile.dob ? Math.floor(diffDays(profile.dob, todayISO()) / 365.25) : 30;
  const hrMax = (profile && profile.hrMax) || Math.round(208 - 0.7 * age);
  return { p5, push, pull, plank, wall, up, core, leg, run, bar: !!(profile && profile.hasBar), hrMax, tested: !!run5k };
}
const paceStr = s => `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}/km`;
function paces(L) {
  return { easy: paceStr(L.p5 * 1.27), long: paceStr(L.p5 * 1.3), tempo: paceStr(L.p5 * 1.09), hard: paceStr(L.p5 * 0.98), strides: paceStr(L.p5 * 0.9) };
}
function zones(L) {
  const z = f => Math.round(L.hrMax * f);
  return { z2: `${z(.65)}–${z(.75)} bpm`, z3: `${z(.76)}–${z(.84)} bpm`, z4: `${z(.85)}–${z(.92)} bpm` };
}

/* ---------- exercise library ---------- */
const X = {
  pushup:   ["Incline push-ups (hands on a bench or bed)", "Push-ups", "Decline push-ups (feet on a chair)", "Archer push-ups"],
  pike:     ["Pike push-ups", "Pike push-ups", "Feet-elevated pike push-ups", "Feet-elevated pike push-ups"],
  dip:      ["Chair dips, knees bent", "Chair dips", "Chair dips, legs straight", "Chair dips, feet raised"],
  pull:     ["Inverted rows under a table", "Inverted rows, feet out", "Inverted rows, feet raised", "Single-arm towel rows"],
  pullbar:  ["Negative pull-ups (5 s down)", "Pull-ups", "Pull-ups", "Weighted or L-sit pull-ups"],
  split:    ["Split squats", "Rear-foot-elevated split squats", "Rear-foot-elevated split squats, 3 s down", "Jumping split squats"],
  hinge:    ["Glute bridges", "Single-leg glute bridges", "Single-leg RDL to reach", "Single-leg RDL, 3 s down"],
  squat:    ["Bodyweight squats", "Squat jumps", "Squat jumps", "Pistol squat to a box"],
  brake:    ["Wall sit", "Wall sit", "Single-leg-bias wall sit (shift 70% to the right leg)", "Single-leg wall sit"],
  calf:     ["Calf raises", "Single-leg calf raises", "Single-leg calf raises, 2 s hold", "Single-leg calf raises off a step"],
  plank:    ["Plank on knees", "Plank", "Plank, shoulder taps", "RKC plank (squeeze everything)"],
  side:     ["Side plank on knees", "Side plank", "Side plank with hip dips", "Side plank, top leg raised"],
  hollow:   ["Dead bugs", "Dead bugs, slow", "Hollow hold", "Hollow rocks"],
  bird:     ["Bird dogs", "Bird dogs, 2 s hold", "Bird dogs, elbow to knee", "Bird dogs, elbow to knee"],
  twist:    ["Seated twists", "Russian twists", "Russian twists, feet up", "V-sit twists"],
  climber:  ["Mountain climbers, slow", "Mountain climbers", "Cross-body mountain climbers", "Cross-body mountain climbers"],
  grip:     ["Towel wring (both directions)", "Towel wring (both directions)", "Fingertip plank holds", "Fingertip push-up holds"],
  hang:     ["Dead hang", "Dead hang", "Dead hang", "Single-arm dead hang alternating"],
  carry:    ["Suitcase carry (bag of water bottles)", "Suitcase carry, heavier bag", "Farmer carry, both hands", "Farmer carry, both hands"],
};
const pick = (k, lv) => X[k][Math.max(0, Math.min(3, lv))];
const reps = (base, f) => Math.max(1, Math.round(base * f));
const secs = (base, f) => Math.round(base * f / 5) * 5;

/* block kinds: warm (timer list) | set (reps x sets, rest) | hold (seconds x sets) | circuit | run (segments) | drill */
const WARM = { kind: "warm", name: "Warm-up", items: [["Jumping jacks", 40], ["Leg swings, each side", 30], ["Arm circles", 20], ["Inchworms", 40], ["Bodyweight squats", 30], ["Hip openers", 30]] };
const WARM_RUN = { kind: "warm", name: "Warm-up", items: [["Brisk walk", 120], ["Leg swings, each side", 30], ["Walking lunges", 40], ["High knees", 20], ["Butt kicks", 20]] };
const COOL = { kind: "warm", name: "Cool-down", items: [["Hip flexor stretch, each side", 40], ["Hamstring stretch, each side", 40], ["Chest opener", 30], ["Child's pose, breathe through the nose", 60]] };

function core(L, f, n = 3) {
  return { kind: "circuit", name: "Core", rounds: n, rest: 45, items: [
    { n: pick("plank", L.core), t: secs(30 + L.core * 10, f) },
    { n: pick("hollow", L.core), r: reps(10, f) },
    { n: pick("side", L.core) + ", each side", t: secs(20 + L.core * 5, f) },
    { n: pick("bird", L.core) + ", each side", r: reps(8, f) },
  ] };
}
function grip(L, f) {
  return L.bar
    ? { kind: "hold", name: "Grip", n: pick("hang", L.up), t: secs(25 + L.up * 10, f), sets: 3, rest: 60, cue: "Full hang, shoulders packed. Grip fails before the wheel does." }
    : { kind: "hold", name: "Grip", n: pick("grip", L.up), t: secs(30 + L.up * 5, f), sets: 3, rest: 45, cue: "Max squeeze the whole time. This is your hands on the wheel at lap 20." };
}

/* ---------- sessions ---------- */
const T = {
  cal_a: "Calisthenics A · upper + grip",
  cal_b: "Calisthenics B · legs + brake leg",
  run_easy: "Easy run",
  run_int: "Intervals",
  run_tempo: "Tempo run",
  run_long: "Long run",
  mob: "Recovery calisthenics · mobility + core",
  test: "Baseline test",
  hotel: "Hotel session",
  act: "Race-day activation",
  recover: "Recovery protocol",
};

function build(type, date, profile, opt = {}) {
  const L = levels(profile), f = opt.f || load(date), P = paces(L), Z = zones(L);
  const s = { type, title: T[type], date, cardio: false, intensity: "mod", blocks: [], est: 30 };
  switch (type) {
    case "test":
      s.title = T.test; s.intensity = "hard"; s.cardio = true; s.est = 60;
      s.note = "Day one. Everything after this is measured against today. Full effort, honest numbers.";
      s.blocks = [WARM,
        { kind: "test", id: "pushups", name: "Max push-ups", cue: "Chest to fist height, full lockout. Stop at the first bad rep." },
        { kind: "test", id: "pullups", name: "Max pull-ups", cue: "Dead hang to chin over the bar. No bar? Skip it.", optional: true },
        { kind: "test", id: "plank", name: "Plank hold (seconds)", cue: "Straight line, ribs down. Stop when the hips drop." },
        { kind: "test", id: "wallsit", name: "Wall sit (seconds)", cue: "Thighs parallel, back flat. This is your brake leg endurance." },
        { kind: "test", id: "reaction", name: "Reaction test", drill: "lights", cue: "Five lights out. Average of five starts." },
        { kind: "test", id: "run5k", name: "5 km time trial", cue: "Wear the Garmin. Even pace, empty the tank in the last kilometre.", run: true },
      ];
      return s;
    case "cal_a":
      s.est = 40 + Math.round(10 * (f - 1) * 3);
      s.blocks = [WARM,
        { kind: "set", n: pick("pushup", L.up), r: reps(8 + L.up * 4, f), sets: 4, rest: 75, cue: "2 s down, drive up. Elbows 45°." },
        { kind: "set", n: L.bar ? pick("pullbar", L.up) : pick("pull", L.up), r: reps(L.bar ? 3 + L.up * 2 : 8 + L.up * 2, f), sets: 4, rest: 75, cue: "Squeeze the shoulder blades. Pull to the chest." },
        { kind: "set", n: pick("pike", L.up), r: reps(6 + L.up * 2, f), sets: 3, rest: 60, cue: "Head through the hands. Shoulders for the G-load." },
        { kind: "set", n: pick("dip", L.up), r: reps(8 + L.up * 3, f), sets: 3, rest: 60 },
        grip(L, f), core(L, f, 2), COOL];
      return s;
    case "cal_b":
      s.est = 40;
      s.blocks = [WARM,
        { kind: "set", n: pick("split", L.leg) + ", each leg", r: reps(8 + L.leg * 2, f), sets: 4, rest: 75, cue: "Front knee tracks the toes. This is your brake leg." },
        { kind: "set", n: pick("hinge", L.leg) + ", each leg", r: reps(10, f), sets: 3, rest: 60 },
        { kind: "set", n: pick("squat", L.leg), r: reps(10 + L.leg * 2, f), sets: 3, rest: 60, cue: "Explode up. Rate of force on the pedal." },
        { kind: "hold", n: pick("brake", L.leg), t: secs(40 + L.leg * 15, f), sets: 3, rest: 60, cue: "Brake hold. 100 bar into the pedal, held through the corner. Don't let the hips rise." },
        { kind: "set", n: pick("calf", L.leg), r: reps(15, f), sets: 3, rest: 45 },
        { kind: "hold", name: "Grip", n: pick("carry", L.up), t: secs(40, f), sets: 3, rest: 45, cue: "Walk tall, no lean. Grip and trunk together." },
        core(L, f, 2), COOL];
      return s;
    case "mob":
      s.intensity = "easy"; s.est = 30;
      s.note = "Rest day still counts. Move, open up, switch the core on. No sweat needed.";
      s.blocks = [
        { kind: "warm", name: "Mobility flow", items: [["Cat-cow", 45], ["World's greatest stretch, each side", 60], ["90/90 hip switches", 60], ["Thoracic rotations, each side", 45], ["Deep squat hold", 45], ["Ankle rocks, each side", 40], ["Neck circles, slow", 30], ["Wrist and forearm stretch", 40]] },
        core(L, Math.min(f, 1), 2),
        { kind: "warm", name: "Breathing", items: [["Box breathing 4-4-4-4", 120]] }];
      return s;
    case "run_easy": {
      const m = Math.round((28 + L.run * 5) * f / 5) * 5;
      s.cardio = true; s.intensity = "easy"; s.est = m + 8;
      s.blocks = [WARM_RUN, { kind: "run", name: "Easy run", segs: [{ l: "Easy", min: m, pace: P.easy, hr: Z.z2 }], cue: `Conversational. Nose breathing if you can. ${P.easy} or slower, ${Z.z2}.` }];
      if (opt.core) s.blocks.push(core(L, f, 2)), s.est += 10, s.title += " + core";
      return s;
    }
    case "run_int": {
      const ph = opt.phase || "base";
      let reps_, on, off;
      if (ph === "taper" || ph === "race") { reps_ = 6; on = 1; off = 1; }
      else if (ph === "build" || ph === "peak") { reps_ = Math.round(5 * f); on = 3; off = 2; }
      else { reps_ = Math.round(6 * f); on = 2; off = 2; }
      s.cardio = true; s.intensity = "hard"; s.est = 10 + 10 + reps_ * (on + off) + 5;
      s.title = `Intervals · ${reps_} × ${on} min`;
      s.blocks = [WARM_RUN, { kind: "run", name: "Intervals", segs: [
        { l: "Easy jog", min: 10, pace: P.easy, hr: Z.z2 },
        ...Array.from({ length: reps_ }, (_, i) => [{ l: `Rep ${i + 1} · hard`, min: on, pace: P.hard, hr: Z.z4, hard: true }, { l: "Recover · jog", min: off, pace: "walk or jog" }]).flat(),
        { l: "Cool-down jog", min: 5, pace: P.easy }],
        cue: `Hard reps at ${P.hard} (${Z.z4}). Same pace every rep. The last one is the one that counts.` }];
      return s;
    }
    case "run_tempo": {
      const t = Math.round((12 + L.run * 3) * f);
      s.cardio = true; s.intensity = "hard"; s.est = 10 + t + 10 + 8; s.title = `Tempo run · ${t} min`;
      s.blocks = [WARM_RUN, { kind: "run", name: "Tempo", segs: [{ l: "Easy", min: 10, pace: P.easy }, { l: "Tempo", min: t, pace: P.tempo, hr: Z.z3, hard: true }, { l: "Easy", min: 10, pace: P.easy }],
        cue: `Comfortably hard. ${P.tempo}, ${Z.z3}. Race-stint focus: hold it without drifting.` }];
      return s;
    }
    case "run_long": {
      const m = Math.round((45 + L.run * 10) * (opt.short ? 0.75 : 1) * f / 5) * 5;
      s.cardio = true; s.intensity = "easy"; s.est = m + 8; s.title = `Long run · ${m} min`;
      s.blocks = [WARM_RUN, { kind: "run", name: "Long run", segs: [{ l: "Steady", min: m, pace: P.long, hr: Z.z2 }],
        cue: `Aerobic engine. ${P.long}, ${Z.z2}. Last 10 min, 6 × 20 s strides at ${P.strides}.` }];
      return s;
    }
    case "hotel":
      s.est = 25; s.note = "Travel day. Hotel room, no kit, no excuses.";
      s.blocks = [WARM, { kind: "circuit", name: "Hotel circuit", rounds: 4, rest: 60, items: [
        { n: pick("pushup", L.up), r: reps(10 + L.up * 3, 1) }, { n: pick("split", L.leg) + ", each leg", r: 10 },
        { n: pick("plank", L.core), t: 40 }, { n: pick("brake", L.leg), t: 45 }, { n: pick("climber", L.core), t: 30 }] },
        grip(L, 1), COOL];
      return s;
    case "act":
      s.intensity = "easy"; s.est = 15; s.title = T.act;
      s.note = "Before the first session. Wake the body up, prime the reactions. Don't empty the tank.";
      s.blocks = [
        { kind: "warm", name: "Activation", items: [["Jumping jacks", 30], ["Leg swings, each side", 30], ["Neck isometrics, 4 directions", 40], ["Squat jumps × 5", 20], ["Wall sit, brake hold", 30], ["Towel wring", 30], ["Box breathing", 60]] },
        { kind: "drill", name: "Reaction primer", drill: "lights" }];
      return s;
    case "recover":
      s.intensity = "easy"; s.est = 20; s.title = T.recover;
      s.note = "Body says no today. Protect the engine: walk, stretch, breathe, sleep early. This counts as done.";
      s.blocks = [
        { kind: "warm", name: "Easy mobility", items: [["Cat-cow", 45], ["Child's pose", 60], ["90/90 hip switches", 60], ["Thoracic rotations, each side", 45], ["Legs up the wall", 120]] },
        { kind: "warm", name: "Breathing", items: [["Box breathing 4-4-4-4", 180]] },
        { kind: "note", text: "Optional: a 15–20 minute walk outside if you're not sick. Fluids, protein, in bed early." }];
      return s;
  }
  return s;
}

/* ---------- the week ---------- */
function baseType(date, profile) {
  const p = phase(date, profile), d = dow(date);
  if (profile && ((!(profile.baseline && profile.baseline.done) && profile.start === date) || (profile.testDays || []).includes(date))) return { type: "test", p };
  if (p.id === "race") return { type: p.day === 0 ? "hotel" : "act", p };
  if (p.id === "post" || p.id === "reset") return { type: d === 1 || d === 4 ? "run_easy" : "mob", p };
  if (p.id === "taper") {
    if (p.back2back) return { type: ["mob", "run_easy", "hotel", "hotel", "act", "act", "act"][d], p };
    return { type: ["cal_a", "run_int", "cal_b", "hotel", "act", "act", "act"][d], p };
  }
  const tpl = p.id === "maintain"
    ? ["cal_a", "run_int", "run_easy", "cal_b", "run_easy", "run_long", "mob"]
    : ["cal_a", "run_int", "run_easy", "cal_b", "run_tempo", "run_long", "mob"];
  return { type: tpl[d], p };
}

function sessionFor(date, profile) {
  const { type, p } = baseType(date, profile);
  const opt = { phase: p.id, core: dow(date) === 2, short: p.id === "maintain" };
  if (p.id === "taper") opt.f = 0.8;
  const s = build(type, date, profile, opt);
  s.phase = p;
  if (p.heat && s.cardio && type !== "run_int") {
    s.heat = true;
    s.blocks.push({ kind: "note", heat: true, text: "Heat block: straight after this, 30–40 min hot bath (about 40 °C) or sauna, or run in an extra layer. Drink 500 ml with electrolytes after. Bahrain and Jeddah cockpits run over 50 °C." });
  }
  if (isDeload(date) && ["base", "build"].includes(p.id)) s.deload = true;
  return s;
}

/* moves: sessions slide one day later; the last one of the week drops. Max 2 a week, never on Sunday. */
const MAX_MOVES = 2;
function weekPlan(date, profile) {
  const mon = monday(date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  let list = days.map(d => sessionFor(d, profile));
  const moves = ((profile && profile.moves) || []).filter(m => m >= mon && m <= addDays(mon, 6)).sort();
  const dropped = [];
  for (const m of moves) {
    const i = dow(m);
    if (i >= 6) continue;
    const gap = { type: "moved", title: "Moved to tomorrow", date: m, blocks: [], est: 0, moved: true };
    list.splice(i, 0, gap);
    const out = list.pop(); if (out && out.type !== "moved") dropped.push(out);
    if (list[i + 1]) list[i + 1] = { ...list[i + 1], fromMove: true };
  }
  list = list.map((s, i) => ({ ...s, date: days[i] }));
  return { mon, days, list, moves, dropped, movesLeft: Math.max(0, MAX_MOVES - moves.length) };
}
function planFor(date, profile) { const w = weekPlan(date, profile); return w.list[dow(date)]; }
function canMove(date, profile) {
  const w = weekPlan(date, profile);
  if (dow(date) === 6) return { ok: false, why: "Sunday closes the week. Get it done today." };
  if (!w.movesLeft) return { ok: false, why: `Both moves used this week. No more slides.` };
  const s = w.list[dow(date)]; if (!s || s.type === "moved") return { ok: false, why: "Nothing to move." };
  return { ok: true, left: w.movesLeft };
}

/* ---------- readiness and the illness guard ---------- */
// light: green | amber | red. Inputs: Oura row (readiness, sleep_score, temp_dev, rhr) + morning check-in.
function readiness(oura, checkin, rhrBase) {
  const why = [];
  let light = "green";
  const red = m => { light = "red"; why.push(m); }, amber = m => { if (light === "green") light = "amber"; why.push(m); };
  const ci = checkin || {};
  if (ci.sick) red("You reported feeling ill");
  if (oura) {
    if (oura.temp_dev != null && oura.temp_dev >= 0.5) red(`Body temperature +${(+oura.temp_dev).toFixed(1)} °C`);
    if (oura.readiness != null && oura.readiness < 55) red(`Readiness ${oura.readiness}`);
    else if (oura.readiness != null && oura.readiness < 70) amber(`Readiness ${oura.readiness}`);
    if (oura.sleep_score != null && oura.sleep_score < 55) red(`Sleep score ${oura.sleep_score}`);
    else if (oura.sleep_score != null && oura.sleep_score < 70) amber(`Sleep score ${oura.sleep_score}`);
    if (rhrBase && oura.rhr && oura.rhr - rhrBase >= 7) red(`Resting HR ${Math.round(oura.rhr)}, ${Math.round(oura.rhr - rhrBase)} above normal`);
    else if (rhrBase && oura.rhr && oura.rhr - rhrBase >= 4) amber(`Resting HR up ${Math.round(oura.rhr - rhrBase)}`);
  }
  if (ci.sleep != null && ci.sleep < 5) red(`${ci.sleep} h sleep`);
  else if (ci.sleep != null && ci.sleep < 6.5) amber(`${ci.sleep} h sleep`);
  if (ci.feel != null && ci.feel <= 1) red("You feel wrecked");
  else if (ci.feel != null && ci.feel === 2) amber("Feeling flat");
  if (ci.sore != null && ci.sore >= 4) amber("Very sore");
  return { light, why };
}

function adapt(session, rd, override) {
  if (!session || session.type === "moved" || session.type === "test") return session;
  if (rd.light === "red") {
    const r = build("recover", session.date, {}, {});
    return { ...r, adapted: "red", original: session.title, why: rd.why, phase: session.phase };
  }
  if (rd.light === "amber" && !override) {
    if (["run_int", "run_tempo"].includes(session.type)) {
      const e = build("run_easy", session.date, {}, { f: 0.7 });
      return { ...session, ...e, title: "Easy run (was " + session.title.toLowerCase() + ")", adapted: "amber", original: session.title, why: rd.why };
    }
    if (session.type === "run_long") {
      const blocks = session.blocks.map(b => b.kind === "run" ? { ...b, segs: b.segs.map(g => ({ ...g, min: Math.round(g.min * 0.7) })) } : b);
      return { ...session, blocks, est: Math.round(session.est * 0.7), adapted: "amber", original: session.title, why: rd.why, title: session.title.replace(/\d+ min/, m => Math.round(parseInt(m) * 0.7) + " min") };
    }
    const blocks = session.blocks.map(b => b.kind === "set" || b.kind === "hold" ? { ...b, sets: Math.max(2, (b.sets || 3) - 1) } : b.kind === "circuit" ? { ...b, rounds: Math.max(1, b.rounds - 1) } : b);
    return { ...session, blocks, adapted: "amber", original: session.title, why: rd.why };
  }
  return session;
}

/* ---------- verification against Garmin (via Strava) ---------- */
const RUNS = /run|treadmill/i;
function verify(session, acts) {
  if (!session || !acts || !acts.length || session.type === "moved") return null;
  const need = Math.max(10, (session.est || 20) * 0.5) * 60;
  const isRun = /^run_/.test(session.type) || session.type === "test";
  const ok = acts.filter(a => (isRun ? RUNS.test(a.sport || "") : true) && (a.dur_s || 0) >= (isRun ? need : Math.min(need, 600)));
  return ok.sort((a, b) => (b.dur_s || 0) - (a.dur_s || 0))[0] || null;
}

/* ---------- nutrition ---------- */
function targets(profile, weight, trainingDay = true) {
  const p = profile || {};
  const w = weight || p.weight || 75, h = p.height || 178;
  const age = p.dob ? Math.floor(diffDays(p.dob, todayISO()) / 365.25) : 30;
  const bmr = 10 * w + 6.25 * h - 5 * age + (p.sex === "f" ? -161 : 5);
  const tdee = bmr * (trainingDay ? 1.55 : 1.4);
  const goal = p.target || w;
  const toLose = Math.max(0, w - goal);
  const rate = toLose > 0.5 ? Math.min(0.0075 * w, 0.75) : 0;          // kg / week, max 0.75% bodyweight
  const deficit = Math.min(650, rate * 7700 / 7);
  const kcal = Math.round(Math.max(bmr * 1.1, tdee - deficit) / 10) * 10;
  const protein = Math.round(Math.min(2.2 * goal, 2.0 * w));
  const fat = Math.round(0.8 * w);
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  const water = Math.round((35 * w + (trainingDay ? 500 : 0)) / 250) * 250;
  const weeks = rate ? Math.ceil(toLose / rate) : 0;
  return { kcal, protein, fat, carbs, water, bmr: Math.round(bmr), tdee: Math.round(tdee), rate: +rate.toFixed(2), weeks, goal };
}
function foodTotals(food) {
  return (food || []).reduce((t, f) => ({ kcal: t.kcal + (+f.kcal || 0), p: t.p + (+f.p || 0), c: t.c + (+f.c || 0), f: t.f + (+f.f || 0) }), { kcal: 0, p: 0, c: 0, f: 0 });
}
// 7-day rolling average of logged weights
function trend(points) {
  const out = [];
  points.forEach((pt, i) => { const win = points.filter(q => diffDays(q.date, pt.date) >= 0 && diffDays(q.date, pt.date) < 7); out.push({ date: pt.date, w: pt.w, avg: win.reduce((s, q) => s + q.w, 0) / win.length }); });
  return out;
}

/* ---------- weekly score /100 ----------
   ctx: { profile, today, day(date)->data, acts(date)->[], oura(date)->row, bt(date)->runs } */
const WEIGHTS = { training: 40, nutrition: 25, recovery: 15, checkin: 10, cognitive: 10 };
function sessionCredit(s, d, acts) {
  if (!s || s.type === "moved") return null;
  const v = verify(s, acts);
  const st = d && d.s && d.s.status;
  let c = 0, how = "missed";
  if (v) { c = 1; how = "verified"; }
  else if (st === "done") { c = s.adapted === "red" || s.intensity === "easy" && !s.cardio ? 0.9 : 0.7; how = "self-reported"; }
  if (s.adapted === "red" && st === "done") { c = 1; how = "protected"; }
  if (c && s.fromMove) c *= 0.85;
  return { c, how, v };
}

function weekScore(dateInWeek, ctx) {
  const p = ctx.profile || {};
  const wk = weekPlan(dateInWeek, p);
  const today = ctx.today || todayISO();
  const days = wk.days.filter(d => d <= today && (!p.start || d >= p.start));
  const n = days.length;
  const parts = {}; const log = [];
  if (!n) return { total: null, parts: {}, days: 0, log, fixes: [] };

  // training
  let got = 0, due = 0, verified = 0, missed = [];
  for (const d of days) {
    const day = ctx.day(d) || {};
    const s0 = wk.list[dow(d)];
    const rd = readiness(ctx.oura(d), day.ci, p.rhrBase);
    const s = adapt(s0, rd, day.override);
    const cr = sessionCredit(s, day, ctx.acts(d));
    if (!cr) continue;
    // today isn't over: only count it once it's done
    if (d === today && cr.c === 0) continue;
    due++; got += cr.c; if (cr.how === "verified") verified++;
    if (cr.c === 0) missed.push(s.title);
    log.push({ date: d, title: s.title, how: cr.how, c: cr.c, adapted: s.adapted, moved: !!s.fromMove });
  }
  parts.training = { pts: due ? WEIGHTS.training * got / due : 0, max: WEIGHTS.training, detail: `${log.filter(l => l.c > 0).length}/${due} sessions · ${verified} verified`, missed, verified, due };

  // today isn't over: it only counts once it's been hit
  const frac = pred => { let hit = 0, den = 0; for (const d of days) { const h = pred(d); if (d < today || h) { den++; if (h) hit++; } } return { hit, den, f: den ? hit / den : 0 }; };
  const dayOf = d => ctx.day(d) || {};
  const tgt = d => targets(p, dayOf(d).w || ctx.lastWeight, true);

  // nutrition: logged every day (15) and on target (10)
  const L = frac(d => { const x = dayOf(d); return (x.food || []).length >= 2 || foodTotals(x.food).kcal >= tgt(d).kcal * 0.5; });
  const O = frac(d => { const x = dayOf(d), t = tgt(d), tot = foodTotals(x.food); return tot.kcal >= t.kcal * 0.9 && tot.kcal <= t.kcal * 1.1 && tot.p >= t.protein * 0.9; });
  parts.nutrition = { pts: 15 * L.f + 10 * O.f, max: WEIGHTS.nutrition, detail: `${L.hit}/${L.den} days logged · ${O.hit} on target`, logged: L.hit, onT: O.hit, den: L.den };

  // recovery: sleep (10) + water (5)
  const S = frac(d => { const o = ctx.oura(d), x = dayOf(d); return o && o.sleep_score != null ? o.sleep_score >= 75 : !!(x.ci && x.ci.sleep >= 7.5); });
  const W = frac(d => (dayOf(d).water || 0) >= tgt(d).water);
  parts.recovery = { pts: 10 * S.f + 5 * W.f, max: WEIGHTS.recovery, detail: `${S.hit}/${S.den} good nights · ${W.hit}/${W.den} water target`, sleepOk: S.hit, waterOk: W.hit };

  // check-in + weigh-in
  const C = frac(d => !!dayOf(d).ci), WI = frac(d => !!dayOf(d).w);
  parts.checkin = { pts: 5 * C.f + 5 * WI.f, max: WEIGHTS.checkin, detail: `${C.hit}/${C.den} check-ins · ${WI.hit}/${WI.den} weigh-ins`, ci: C.hit, wi: WI.hit };

  // cognitive: 5 drill days a week (Brake Trainer runs count)
  let cog = 0;
  for (const d of days) { const x = dayOf(d); if ((x.drills || []).length || (ctx.bt && ctx.bt(d))) cog++; }
  const cogTarget = Math.max(1, Math.round(5 * n / 7));
  parts.cognitive = { pts: WEIGHTS.cognitive * Math.min(1, cog / cogTarget), max: WEIGHTS.cognitive, detail: `${cog} drill days (target ${cogTarget})`, cog, cogTarget };

  const total = Math.round(Object.values(parts).reduce((s, x) => s + x.pts, 0));
  return { total, parts, days: n, log, fixes: fixes(parts), complete: n === 7 };
}

function fixes(parts) {
  const out = [];
  const lost = Object.entries(parts).map(([k, v]) => [k, v.max - v.pts, v]).filter(x => x[1] >= 1).sort((a, b) => b[1] - a[1]);
  for (const [k, l, v] of lost.slice(0, 3)) {
    const pts = Math.round(l);
    if (k === "training") out.push(v.missed.length ? `Training cost you ${pts} points. Missed: ${v.missed.join(", ")}. Lock the time in the night before.` : `Training cost you ${pts} points: sessions not verified. Make sure Garmin syncs to Strava.`);
    if (k === "nutrition") out.push(`Nutrition cost you ${pts} points. ${v.logged < v.den ? "Log every meal, not just the good ones." : "Logged, but off target. Protein first at every meal."}`);
    if (k === "recovery") out.push(`Recovery cost you ${pts} points. ${v.sleepOk < v.waterOk ? "Sleep is the gap: same bedtime every night, screens off 30 min before." : "Hydration is the gap: 500 ml as soon as you wake up."}`);
    if (k === "checkin") out.push(`Check-in cost you ${pts} points. Weigh in and check in before you look at your phone for anything else.`);
    if (k === "cognitive") out.push(`Cognitive cost you ${pts} points. Three minutes of reaction work, five days a week. On the rig, Brake Trainer counts.`);
  }
  return out;
}

function grade(n) { return n == null ? "" : n >= 90 ? "Podium" : n >= 80 ? "Points" : n >= 65 ? "Midfield" : n >= 50 ? "Off the pace" : "DNF"; }

const api = { pad, iso, parse, addDays, dow, monday, diffDays, todayISO, F3, SEASON, events, nextEvent, phase, load, isDeload, weekIndex,
  levels, paces, zones, build, sessionFor, weekPlan, planFor, canMove, MAX_MOVES, readiness, adapt, verify, targets, foodTotals, trend,
  weekScore, sessionCredit, WEIGHTS, grade, T, PROG_START };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FX = api;
})(typeof window !== "undefined" ? window : globalThis);
