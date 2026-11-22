// Çini Salonu · çevrimdışı kabuk. Sayfalar önce ağdan gelir (yeni sürüm hemen görünür), ağ yoksa kayıtlı kopya.
// Yalnız bu sitenin GET istekleri; Supabase ve iyzico'ya hiç dokunmaz.
const C = 'cini-v1';
const KABUK = ['./', './index.html', './yasal.html', './manifest.webmanifest', './ikon-192.png', './ikon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(KABUK)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(x => { if (x.ok) { const k = x.clone(); caches.open(C).then(c => c.put(u.pathname, k)); } return x; })
      .catch(() => caches.match(u.pathname).then(m => m || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r)));
});
