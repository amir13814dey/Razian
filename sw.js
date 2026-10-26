// Razian Price — Service Worker
// Cache strategies per route, push notifications, background sync, versioning.

const VERSION = 'v1.0.0';
const SHELL_CACHE = `razian-shell-${VERSION}`;
const DATA_CACHE = `razian-data-${VERSION}`;
const STATIC_CACHE = `razian-static-${VERSION}`;
const ALL_CACHES = [SHELL_CACHE, DATA_CACHE, STATIC_CACHE];

// App shell — cached on install
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles/main.css',
  '/src/app.js',
  '/src/core/db.js',
  '/src/core/timeseries.js',
  '/src/core/registry.js',
  '/src/core/bus.js',
  '/src/sources/base.js',
  '/src/sources/biquote.js',
  '/src/sources/goldapi.js',
  '/src/sources/iran.js',
  '/src/sources/coingecko.js',
  '/src/views/market.js',
  '/src/views/chart.js',
  '/src/views/portfolio.js',
  '/src/views/alerts.js',
  '/src/views/settings.js',
  '/src/workers/indicators.worker.js',
  '/src/workers/alerts.worker.js',
  '/src/crdt/lwwmap.js',
  '/fonts/Vazirmatn-Regular.woff2',
  '/fonts/Vazirmatn-Bold.woff2',
  '/icons/razian-192.png',
  '/icons/razian-512.png',
];

// API hosts — data cache strategy
const DATA_HOSTS = [
  'biquote.io',
  'api.gold-api.com',
  'nerkh.jahankhahan.shop',
  'api.coingecko.com',
];

// ---------- Install ----------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll fails atomically if any asset 404s — use individual adds
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) =>
            console.warn(`[sw] shell asset failed: ${url}`, err)
          )
        )
      );
      // Don't call skipWaiting automatically — let the UI prompt the user.
    })()
  );
});

// ---------- Activate ----------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !ALL_CACHES.includes(k)).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ---------- Fetch ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) API data → stale-while-revalidate
  if (DATA_HOSTS.some((h) => url.hostname.includes(h))) {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }

  // 2) Navigation → shell fallback
  if (req.mode === 'navigate') {
    event.respondWith(navigationHandler(req));
    return;
  }

  // 3) Static (JS, CSS, fonts, icons) → cache-first
  event.respondWith(cacheFirst(req, STATIC_CACHE));
});

async function navigationHandler(req) {
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(SHELL_CACHE);
    cache.put('/index.html', fresh.clone());
    return fresh;
  } catch {
    return (await caches.match('/index.html')) || Response.error();
  }
}

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    return Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);

  const networkPromise = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }
  const fresh = await networkPromise;
  return fresh || new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------- Push notifications ----------
self.addEventListener('push', (event) => {
  let data = { title: 'Razian', body: 'قیمت هشدار', tag: 'razian-alert' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: '/icons/razian-192.png',
      badge: '/icons/badge-72.png',
      dir: 'rtl',
      lang: 'fa',
      vibrate: [80, 40, 80],
      data: data.data || {},
      actions: [
        { action: 'open', title: 'مشاهده' },
        { action: 'dismiss', title: 'بستن' },
      ],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/?tab=alerts';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of allClients) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({ type: 'NAVIGATE', url: targetUrl });
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })()
  );
});

// ---------- Background sync ----------
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-alerts') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'SYNC_ALERTS' }));
      })
    );
  }
  if (event.tag === 'sync-portfolio') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'SYNC_PORTFOLIO' }));
      })
    );
  }
});

// ---------- Messages from clients ----------
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
