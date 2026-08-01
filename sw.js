// Zaikon PWA: ページを開くたびにHTMLはネットから最新版を取得
const CACHE_VERSION = 'zaikon-live-v2';
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){
  e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(function(keys){ return Promise.all(keys.map(function(k){ return caches.delete(k); })); })
  ]));
});
self.addEventListener('fetch', function(e){
  if(e.request.mode === 'navigate'){
    e.respondWith(fetch(e.request, {cache:'no-store'}).catch(function(){ return fetch(e.request); }));
  }
});
