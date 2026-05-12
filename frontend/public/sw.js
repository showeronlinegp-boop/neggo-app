// Service Worker — Neggo PWA
// Estrategia por tipo de recurso:
//   API (/api/*)      → network-only (nunca cachear)
//   JS/CSS con hash   → network-only (Vite genera hashes nuevos por build, cache-first los rompe)
//   HTML (index.html) → network-first, fallback a cache (permite offline básico)
//   SVG/PNG/icons     → cache-first (cambian poco, inofensivos)

const CACHE_NAME = 'neggo-v2';

const PRECACHE = [
    '/manifest.json',
    '/icon-192.svg',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
    );
    // Activar inmediatamente sin esperar a que se cierren las tabs viejas
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Solo manejar requests del mismo origen
    if (url.origin !== self.location.origin) return;

    // 1. API — network-only, nunca cachear
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(request).catch(() =>
                new Response(
                    JSON.stringify({ success: false, error: 'Sin conexión' }),
                    { headers: { 'Content-Type': 'application/json' } }
                )
            )
        );
        return;
    }

    // 2. Chunks JS/CSS de Vite (tienen hash en el nombre, ej: assets/index-Df7V.js)
    //    → network-only: son efímeros, cambiar el hash = archivo nuevo.
    //      cache-first los rompe entre builds porque el hash viejo nunca expira.
    if (url.pathname.startsWith('/assets/')) {
        event.respondWith(fetch(request));
        return;
    }

    // 3. HTML (navegación SPA) → network-first, fallback a cache para offline
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).then((response) => {
                // Guardar la última versión buena del HTML
                if (response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                }
                return response;
            }).catch(() => caches.match('/index.html'))
        );
        return;
    }

    // 4. Resto (iconos, manifest, fonts) → cache-first
    event.respondWith(
        caches.match(request).then((cached) => {
            return cached || fetch(request).then((response) => {
                if (response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                }
                return response;
            });
        })
    );
});
