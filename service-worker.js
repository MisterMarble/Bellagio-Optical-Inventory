self.addEventListener('install', (e)=>{
  e.waitUntil(
    caches.open('bellagio-stock-ocr-v3').then(cache=>cache.addAll([
      './',
      './index.html',
      './styles.css',
      './app.js',
      './manifest.webmanifest',
      './data/slabs.csv',
      './icons/icon-48.png',
      './icons/icon-72.png',
      './icons/icon-96.png',
      './icons/icon-144.png',
      './icons/icon-192.png',
      './icons/icon-512.png',
      './icons/icon-maskable.png'
    ]))
  );
});
self.addEventListener('fetch', (e)=>{
  e.respondWith(
    caches.match(e.request).then(res=>res || fetch(e.request))
  );
});
