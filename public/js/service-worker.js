// service-worker.js

// Cache name for our app
const CACHE_NAME = 'posture-detection-v1';

// Files to cache
const urlsToCache = [
  '/',
  '/index.html',
  '/js/app.js',
  '/css/styles.css',
  // Add other assets your app needs
];

// Install event - cache assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache opened');
        return cache.addAll(urlsToCache);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

// Fetch event - serve from cache if available
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
  );
});

// Listen for messages from the main thread
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'POSTURE_CHECK') {
    // Handle background posture check if needed
    console.log('Service worker received posture check request');
  }
});

// Background sync registration
self.addEventListener('sync', event => {
  if (event.tag === 'posture-sync') {
    event.waitUntil(syncPostureData());
  }
});

// Function to sync data in background
async function syncPostureData() {
  console.log('Background sync executed');
  // Perform any background sync operations here
}