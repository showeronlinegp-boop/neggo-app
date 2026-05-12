// Service Worker — Neggo App
const CACHE_VERSION = 'neggo-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const API_CACHE = `${CACHE_VERSION}-api`;

// Patrones de assets estáticos
const STATIC_PATTERNS = [
    /\/assets\//,
    /\.js$/,
    /\.css$/,
    /\.png$/,
    /\.ico$/,
    /\.svg$/,
    /\.woff2?$/,
];

// HTML de fallback offline
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sin conexión — Neggo</title>
    <style>
        body {
            font-family: system-ui, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #F5F5F5;
        }
        .card {
            background: #fff;
            border-radius: 12px;
            padding: 48px 64px;
            text-align: center;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        h1 { color: #003366; margin-bottom: 8px; }
        p  { color: #666; margin: 0; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Sin conexión</h1>
        <p>No tenés acceso a internet. Revisá tu red e intentá de nuevo.</p>
    </div>
</body>
</html>`;

// ── Install: pre-cachear shell de la app ──────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE).then((cache) =>
            cache.addAll(['/', '/index.html'])
        ).then(() => self.skipWaiting())
    );
});

// ── Activate: limpiar caches viejos ──────────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k !== STATIC_CACHE && k !== API_CACHE)
                    .map((k) => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// ── Fetch: estrategia por tipo de recurso ────────────────────────────────────
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Solo manejar GET
    if (request.method !== 'GET') return;

    // Llamadas a /api/ → network-first
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirst(request, API_CACHE));
        return;
    }

    // Assets estáticos → cache-first
    if (STATIC_PATTERNS.some((p) => p.test(url.pathname))) {
        event.respondWith(cacheFirst(request, STATIC_CACHE));
        return;
    }

    // Navegación (HTML) → network-first con fallback offline
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(() =>
                caches.match('/index.html').then((cached) =>
                    cached || new Response(OFFLINE_HTML, {
                        headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    })
                )
            )
        );
    }
});

// ── Estrategia: cache-first ──────────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        return new Response('Sin conexión', { status: 503 });
    }
}

// ── Estrategia: network-first ─────────────────────────────────────────────────
async function networkFirst(request, cacheName) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response(
            JSON.stringify({ success: false, error: 'Sin conexión' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
