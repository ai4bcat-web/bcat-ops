/*
 * Reload every open driver tab the moment a new service worker takes over.
 *
 * This runs INSIDE the service worker, pulled in by Workbox's importScripts, which is
 * what lets it reach a phone running an OLD build. Nothing shipped in a new bundle can
 * execute on a stale page; this can, because the browser installs the new worker on the
 * next visit regardless of what the page is running.
 *
 * Why it exists: the first PWA precached index.html. A phone holding that worker served
 * the old shell on every visit, installed the new worker in the background, and only
 * saw fresh HTML on the visit AFTER that. One reload behind, every time — Jason opened the
 * app on 6 Oct and got a tab bar from before the Ivan program existed.
 *
 * `WindowClient.navigate()` is the clean fix and is what Chrome and Android run. Safari
 * does not implement it, so those clients get a message instead, which the current
 * bundle listens for (src/lib/swUpdate.ts). An old Safari bundle hears neither — it is
 * still one manual reload away, and nothing can change that from here.
 *
 * Never reload the scanner. Captured pages live in memory until they are sent, and a
 * reload would bin a POD somebody just photographed at a dock. The page-side listener
 * makes the same exception.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of clients) {
        let path = ''
        try { path = new URL(client.url).pathname } catch { /* not a URL we can judge; be conservative */ }
        if (path.startsWith('/driver/scan')) continue
        if (typeof client.navigate === 'function') {
          // Same URL, fresh document: the only way a stale page swaps its JavaScript.
          client.navigate(client.url).catch(() => client.postMessage({ type: 'BCAT_SW_UPDATED' }))
        } else {
          client.postMessage({ type: 'BCAT_SW_UPDATED' })
        }
      }
    })(),
  )
})
