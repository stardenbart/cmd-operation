/*
 * Service worker CMD 1 Operation - PWA.
 *
 * Tujuannya membuat aplikasi dapat DIPASANG ke homescreen dan tetap membuka
 * cangkang aplikasi saat jaringan putus. BUKAN cache data: seluruh /api/ selalu
 * lewat jaringan supaya stok, approval, dan waktu tidak pernah basi.
 *
 * Catatan: service worker hanya aktif di konteks aman (HTTPS atau localhost),
 * jadi pemasangan berjalan lewat endpoint HTTPS (mis. :8443), bukan HTTP polos.
 */
const CACHE = 'cmd1-op-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Buang cache versi lama supaya rilis baru tidak tersangkut aset lama.
    const kunci = await caches.keys();
    await Promise.all(kunci.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // pihak ketiga: biarkan
  if (url.pathname.startsWith('/api/')) return;       // data: selalu jaringan

  // Navigasi halaman: jaringan dulu, jatuh ke cangkang tersimpan saat offline.
  if (request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(request);
        const salin = res.clone();
        caches.open(CACHE).then((c) => c.put('/', salin)).catch(() => {});
        return res;
      } catch {
        return (await caches.match('/')) || (await caches.match(request)) || Response.error();
      }
    })());
    return;
  }

  // Aset statik (js/css/font/gambar): dari cache dulu, isi ulang di belakang.
  e.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const res = await fetch(request);
    if (res.ok) {
      const salin = res.clone();
      caches.open(CACHE).then((c) => c.put(request, salin)).catch(() => {});
    }
    return res;
  })());
});
