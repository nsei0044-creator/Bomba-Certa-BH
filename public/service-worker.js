const CACHE = 'bomba-certa-v2';
const ARQUIVOS = ['./', 'index.html', 'style.css', 'app.js', 'firebase-config.js', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js'];

self.addEventListener('install', e => {
  // um arquivo que falhe não impede a instalação
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(ARQUIVOS.map(a => c.add(a)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// rede primeiro (você sempre vê a versão nova), cache só como plano B offline
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || !(u.origin === location.origin || u.hostname === 'unpkg.com')) return;
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const c = res.clone(); caches.open(CACHE).then(ch => ch.put(r, c)); }
    return res;
  }).catch(() => caches.match(r).then(m => m || caches.match('index.html'))));
});
