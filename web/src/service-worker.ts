/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { immutable, assets, prerendered } from '$app/manifest';
import { version } from '$app/env';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `ff-${version}`;

// Only small static assets are precached; never HTML (the app shell is always fetched fresh).
const abs = (p: string) => (p.startsWith('/') ? p : `/${p}`);
const staticFiles = assets.map((a) => abs(a.path)).filter((f) => /^\/(icon-.*\.png|apple-touch-icon\.png|favicon\.(svg|ico)|logo-icon\.svg|manifest\.webmanifest)$/.test(f));
const PRECACHE = [...new Set([...immutable.map((a) => abs(a.path)), ...prerendered.map((a) => abs(a.path)), ...staticFiles])];
const ASSETS = new Set(PRECACHE.filter((p) => p !== '/offline'));
const BYPASS = ['/api/', '/media/', '/auth/', '/ws/', '/internal/', '/health', '/metrics'];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => sw.skipWaiting())
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ff-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  if (req.headers.has('range')) return;
  if (BYPASS.some((p) => url.pathname === p.replace(/\/$/, '') || url.pathname.startsWith(p))) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match('/offline', { cacheName: CACHE })) ?? Response.error())
    );
    return;
  }

  if (ASSETS.has(url.pathname)) {
    event.respondWith(
      caches.match(req, { cacheName: CACHE }).then(async (hit) => {
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && res.type === 'basic' && !res.redirected) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    );
  }
  // everything else: network only (no respondWith)
});

// push handlers
import { installPush } from '#lib/sw/push';
installPush(sw);
