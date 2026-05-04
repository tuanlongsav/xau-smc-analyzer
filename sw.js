// ============================================================
// Service Worker — PWA cache strategy
// ============================================================
// Cache strategy:
// - App shell (HTML/JS/CSS): cache-first, update khi version bump
// - API calls (TwelveData/Gemini/RSS): network-only (luôn cần fresh)
// - Icons + Tailwind/CDN: cache-first

const VERSION = "v1.12.0";
const APP_CACHE = `xau-smc-app-${VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/app.js",
  "./js/config.js",
  "./js/data.js",
  "./js/indicators.js",
  "./js/prompts.js",
  "./js/gemini.js",
  "./js/chart.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== APP_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Bỏ qua mọi request không phải GET
  if (e.request.method !== "GET") return;

  // API calls → network only (data fresh)
  const NETWORK_ONLY_HOSTS = [
    "api.twelvedata.com",          // (chỉ khi user override Gemini key - không dùng nữa cho data)
    "generativelanguage.googleapis.com",
    "api.rss2json.com",
    "api.allorigins.win",
    "workers.dev",                 // Cloudflare Worker proxy (Gemini + TwelveData)
  ];
  if (NETWORK_ONLY_HOSTS.some(h => url.hostname.includes(h))) {
    return; // mặc định fetch — không SW handle
  }

  // App shell + CDN: cache-first, fallback network, fallback error response
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok && (url.origin === self.location.origin ||
                       url.hostname.includes("cdn.tailwindcss.com") ||
                       url.hostname.includes("unpkg.com"))) {
          const clone = res.clone();
          caches.open(APP_CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch((err) => {
        // Network fail + không có cache → trả Response 504 thay vì undefined
        return new Response(
          `Service worker offline fallback: ${err.message}`,
          { status: 504, headers: { "Content-Type": "text/plain" } }
        );
      });
    })
  );
});
