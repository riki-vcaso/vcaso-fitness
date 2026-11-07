/* VCASO Fitness · cognitive and reaction drills.
   FXD.run(kind, el) renders into el and resolves with a result, or null if abandoned. */
(function () {
"use strict";
const now = () => performance.now();
const wait = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

const INFO = {
  lights: { name: "Lights out", what: "Five red lights. When they go out, tap. Average of five starts. Tap early and it's a jump start.", unit: "ms" },
  gonogo: { name: "Go / No-go", what: "Green: tap as fast as you can. Red: don't touch. 30 signals. Speed with control, like a restart behind the safety car.", unit: "ms" },
  peripheral: { name: "Peripheral targets", what: "Eyes on the centre dot. Targets flash at the edges, tap them. 20 targets. Mirrors picking up a car in your mirrors.", unit: "ms" },
};

function lightsDrill(el) {
  return new Promise(resolve => {
    let alive = true, trial = 0, times = [], jumps = 0, state = "idle", outAt = 0, timer = null;
    el.innerHTML = `<div class="drill"><div class="eyebrow">Start <span id="dN">1</span> of 5</div>
      <div class="lights" id="dL">${"<i></i>".repeat(5)}</div>
      <div class="pad" id="dP" style="aspect-ratio:2/1"><div class="msg" id="dM">Tap to arm</div></div>
      <div class="ms" id="dT">&nbsp;</div><button class="btn ghost" id="dX">Abandon</button></div>`;
    const L = [...el.querySelectorAll("#dL i")], M = el.querySelector("#dM"), Tm = el.querySelector("#dT"), N = el.querySelector("#dN");
    const done = r => { alive = false; clearTimeout(timer); resolve(r); };
    el.querySelector("#dX").onclick = () => done(null);
    async function sequence() {
      state = "lighting"; M.textContent = "Wait for lights out"; Tm.innerHTML = "&nbsp;";
      L.forEach(i => i.classList.remove("on"));
      for (let i = 0; i < 5; i++) { await wait(900); if (!alive || state !== "lighting") return; L[i].classList.add("on"); buzz(10); }
      await wait(rnd(200, 3000)); if (!alive || state !== "lighting") return;
      L.forEach(i => i.classList.remove("on")); outAt = now(); state = "out";
      timer = setTimeout(() => { if (state === "out") { state = "idle"; M.textContent = "Too slow. Tap to go again"; } }, 1500);
    }
    el.querySelector("#dP").addEventListener("pointerdown", e => {
      e.preventDefault();
      if (state === "idle") return sequence();
      if (state === "lighting") { state = "idle"; jumps++; L.forEach(i => i.classList.remove("on")); Tm.innerHTML = `<span class="bad">JUMP START</span>`; M.textContent = "Tap to go again"; buzz([60, 40, 60]); return; }
      if (state === "out") {
        clearTimeout(timer);
        const t = Math.round(now() - outAt); times.push(t); trial++; state = "idle";
        Tm.textContent = t + " ms"; buzz(15);
        if (trial >= 5) { M.textContent = "Done"; setTimeout(() => done({ kind: "lights", avg: Math.round(avg(times)), best: Math.min(...times), times, jumps }), 700); }
        else { N.textContent = trial + 1; M.textContent = "Tap for the next start"; }
      }
    });
  });
}

function goNoGo(el) {
  return new Promise(resolve => {
    const total = 30; let alive = true, i = 0, rts = [], miss = 0, falseHits = 0, cur = null;
    el.innerHTML = `<div class="drill"><div class="eyebrow"><span id="dN">0</span> / ${total}</div>
      <div class="pad" id="dP"><div class="msg" id="dM">Tap to start</div></div>
      <div class="row"><span class="chip" id="dA">Avg —</span><span class="chip" id="dE">Errors 0</span></div><button class="btn ghost" id="dX">Abandon</button></div>`;
    const P = el.querySelector("#dP"), M = el.querySelector("#dM");
    const done = r => { alive = false; resolve(r); };
    el.querySelector("#dX").onclick = () => done(null);
    let started = false;
    async function loop() {
      while (alive && i < total) {
        M.textContent = "+"; await wait(rnd(600, 1400)); if (!alive) return;
        const go = Math.random() < 0.7;
        cur = { go, at: now(), hit: false };
        M.innerHTML = `<span style="display:block;width:38%;aspect-ratio:1;margin:auto;border-radius:50%;background:${go ? "var(--ok)" : "var(--bad)"}"></span>`;
        await wait(go ? 700 : 900);
        if (!cur.hit && go) { miss++; buzz([40, 30, 40]); }
        cur = null; i++; el.querySelector("#dN").textContent = i;
        el.querySelector("#dE").textContent = "Errors " + (miss + falseHits);
      }
      if (alive) {
        const acc = Math.round(100 * (total - miss - falseHits) / total);
        done({ kind: "gonogo", avg: rts.length ? Math.round(avg(rts)) : null, best: rts.length ? Math.min(...rts) : null, acc, miss, falseHits });
      }
    }
    P.addEventListener("pointerdown", e => {
      e.preventDefault();
      if (!started) { started = true; loop(); return; }
      if (!cur || cur.hit) return;
      cur.hit = true;
      if (cur.go) { const t = Math.round(now() - cur.at); rts.push(t); el.querySelector("#dA").textContent = "Avg " + Math.round(avg(rts)) + " ms"; buzz(10); M.innerHTML = `<span class="ms">${t}</span>`; }
      else { falseHits++; buzz([80]); M.innerHTML = `<span class="bad" style="font-family:var(--display)">NO-GO</span>`; }
    });
  });
}

function peripheral(el) {
  return new Promise(resolve => {
    const total = 20; let alive = true, i = 0, rts = [], miss = 0, cur = null, started = false;
    const spots = [[6, 6], [50, 4], [94, 6], [96, 50], [94, 94], [50, 96], [6, 94], [4, 50]];
    el.innerHTML = `<div class="drill"><div class="eyebrow"><span id="dN">0</span> / ${total}</div>
      <div class="pad" id="dP"><span style="width:10px;height:10px;border-radius:50%;background:var(--ink);position:absolute"></span><div class="msg" id="dM" style="margin-top:60px">Eyes on the dot. Tap to start</div></div>
      <div class="row"><span class="chip" id="dA">Avg —</span><span class="chip" id="dE">Missed 0</span></div><button class="btn ghost" id="dX">Abandon</button></div>`;
    const P = el.querySelector("#dP"), M = el.querySelector("#dM");
    const done = r => { alive = false; resolve(r); };
    el.querySelector("#dX").onclick = () => done(null);
    async function loop() {
      M.textContent = "";
      while (alive && i < total) {
        await wait(rnd(500, 1300)); if (!alive) return;
        const [x, y] = spots[Math.floor(Math.random() * spots.length)];
        const t = document.createElement("span"); t.className = "tgt";
        t.style.cssText = `left:calc(${x}% - 12%);top:calc(${y}% - 12%);background:var(--cg);transform:scale(.62)`;
        P.appendChild(t); cur = { at: now(), el: t, hit: false };
        t.addEventListener("pointerdown", ev => { ev.preventDefault(); ev.stopPropagation(); if (cur && !cur.hit) { cur.hit = true; const ms = Math.round(now() - cur.at); rts.push(ms); buzz(10); el.querySelector("#dA").textContent = "Avg " + Math.round(avg(rts)) + " ms"; t.remove(); } });
        await wait(1100);
        if (cur && !cur.hit) { miss++; el.querySelector("#dE").textContent = "Missed " + miss; }
        if (cur) cur.el.remove(); cur = null; i++; el.querySelector("#dN").textContent = i;
      }
      if (alive) done({ kind: "peripheral", avg: rts.length ? Math.round(avg(rts)) : null, best: rts.length ? Math.min(...rts) : null, acc: Math.round(100 * (total - miss) / total), miss });
    }
    P.addEventListener("pointerdown", e => { e.preventDefault(); if (!started) { started = true; loop(); } });
  });
}

window.FXD = { INFO, run(kind, el) { return ({ lights: lightsDrill, gonogo: goNoGo, peripheral })[kind](el); } };
})();
