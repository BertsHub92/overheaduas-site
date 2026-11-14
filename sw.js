// Overhead UAS Pilot Portal - offline support.
// Keeps the portal page, libraries, and the (encrypted) form files on the device so pilots can
// open the portal, sign in, fill out, and sign forms with no cell service. Only portal files are
// handled; the public website and every other request go straight to the network.
const CACHE = 'ouas-portal-v1';
const PRECACHE = ['pilots.html', 'planner.js', 'portal.webmanifest', 'logo.png', 'favicon-192.png', 'apple-touch-icon.png',
  'vendor/pdf-lib.min.js', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css'];
const FRESH = /\/(pilots\.html|pilots\/?|planner\.js|version\.json|portal\.webmanifest|portal\/keys\.json|portal\/manifest\.bin)$/;   // network first
const STATIC = /\/(portal\/f-[0-9a-f]+\.bin|vendor\/.+|logo\.png|cert-logo\.jpg|favicon[^/]*|apple-touch-icon\.png)$/;            // cache first

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(PRECACHE.map(u => c.add(new Request(u, {cache: 'reload'})).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('ouas-portal-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (FRESH.test(path)) e.respondWith(networkFirst(req, path));
  else if (STATIC.test(path)) e.respondWith(cacheFirst(req));
});
async function networkFirst(req, path) {
  const c = await caches.open(CACHE);
  try {
    const res = await fetch(req.url, {cache: 'no-store', credentials: 'same-origin'});   // plain URL: navigation requests can't be re-used with options
    if (res.ok && !/\/pilots\/?$/.test(path)) c.put(req.url.split('?')[0], res.clone());   // /pilots/ is only a redirect page
    return res;
  } catch (err) {
    if (/\/pilots\/?$/.test(path)) return Response.redirect('/pilots.html', 302);   // offline: send the short link to the saved portal page
    const hit = await c.match(req, {ignoreSearch: true});
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req) {
  const c = await caches.open(CACHE), hit = await c.match(req, {ignoreSearch: true});
  if (hit) return hit;
  const res = await fetch(req); if (res.ok) c.put(req.url.split('?')[0], res.clone());
  return res;
}
