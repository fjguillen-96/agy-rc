// public/sw.js
// Service worker: precache del shell + vendor, network-first para navegación,
// stale-while-revalidate para el resto. /api y /ws nunca se interceptan.

// El servidor sustituye esta línea por 'agyrc-<build>' al servir /sw.js (server/build.js):
// no hace falta subir la versión a mano en cada despliegue.
const CACHE_NAME = 'agyrc-dev';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/main.js',
  '/js/i18n.js',
  '/js/api.js',
  '/js/socket.js',
  '/js/store.js',
  '/js/pwa.js',
  '/js/updates.js',
  '/js/viewport.js',
  '/js/telemetry.js',
  '/js/ui/icons.js',
  '/js/ui/drawer.js',
  '/js/ui/sheets.js',
  '/js/ui/directory.js',
  '/js/ui/toast.js',
  '/js/chat/chat-view.js',
  '/js/chat/chat-topbar.js',
  '/js/chat/chat-socket.js',
  '/js/chat/chat-dock.js',
  '/js/chat/agy-log.js',
  '/js/chat/new-chat.js',
  '/js/chat/markdown.js',
  '/js/chat/tool-card.js',
  '/vendor/marked/marked.umd.js',
  '/vendor/dompurify/purify.min.js',
  '/manifest.json',
  '/manifest.es.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/logo-256.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(url);
          } catch {
            // un recurso ausente no debe romper la instalación completa
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApiOrWs(url) {
  return url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname === '/ws';
}

async function networkFirstNavigation(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put('/index.html', fresh.clone());
    return fresh;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match('/index.html');
    if (cached) return cached;
    throw new Error('offline y sin caché');
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    networkPromise.catch(() => {});
    return cached;
  }
  const network = await networkPromise;
  if (network) return network;
  throw new Error('recurso no disponible');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApiOrWs(url)) return; // network only, no interceptar

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
