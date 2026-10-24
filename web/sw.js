importScripts('./version.js');

const CACHE = `consumable-${self.APP_VERSION}`;
const PRECACHE = [
  './',
  './index.html',
  './version.js',
  './db.js',
  './forecast.js',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
];

self.addEventListener('install', (e) => {
  // HTTP キャッシュを通さず最新のファイルを取りにいく
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
  );
  // 新しいバージョンは、画面で「更新する」が押されるまで待機する（初回インストール時はすぐ有効）
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'GET_VERSION' && e.ports[0]) {
    e.ports[0].postMessage({ version: self.APP_VERSION, changes: self.APP_CHANGES });
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 同一オリジンの GET だけ扱う（POST や外部リソースは素通し）
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // キャッシュ優先: 画面は同じバージョンのファイルだけで動く。更新は新しい SW の切り替えで行う
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(req, clone));
      }
      return res;
    }))
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // すでに開いている画面があればそれを前面に出す
      for (const c of list) {
        if ('focus' in c) {
          c.navigate?.(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
