/* VCASO Fitness service worker: works offline in a hotel or on the rig, shows the morning alert. */
const CACHE = "fx-v2";
const SHELL = ["./", "index.html", "style.css?v=2", "config.js?v=2", "js/logo.js", "js/engine.js?v=2", "js/drills.js?v=2", "js/app.js?v=2", "manifest.webmanifest", "img/icon-192.png"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
// network first for our own files, cache when offline; everything else goes straight to the network
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const own = u.origin === location.origin, cdn = /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(u.host);
  if (!own && !cdn) return;
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r.ok) { const c = await caches.open(CACHE); c.put(e.request, r.clone()); }
      return r;
    } catch (err) {
      const hit = await caches.match(e.request, { ignoreSearch: own && u.pathname.endsWith("/") });
      if (hit) return hit;
      if (e.request.mode === "navigate") return (await caches.match("index.html")) || Response.error();
      throw err;
    }
  })());
});
self.addEventListener("push", e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch (_) { m = { title: "VCASO Fitness", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(m.title || "VCASO Fitness", { body: m.body || "", icon: "img/icon-192.png", badge: "img/icon-192.png", tag: m.tag || "fx", renotify: true, data: { url: m.url || "./" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { await c.focus(); if ("navigate" in c) { try { await c.navigate(url); } catch (_) {} } return; } }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
