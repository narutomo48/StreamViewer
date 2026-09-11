// Minimal "app shell" service worker: caches the static shell so the app is
// installable and opens instantly, but always goes to the network for the
// shell files when online (network-first) so updates are picked up quickly.
// Video/chat iframes and API calls are never cached -- they must stay live.

const CACHE_NAME = "streamviewer-shell-v3";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/main.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // never intercept cross-origin (YouTube/Twitch/API) requests
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request, { cache: "no-store" }) // always bypass the browser's own HTTP cache too
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
