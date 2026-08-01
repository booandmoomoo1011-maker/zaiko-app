// PWA installability 用の最小サービスワーカー（キャッシュしない・素通し）
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e){ /* 素通し：ブラウザ既定の取得。キャッシュしない */ });
