/**
 * Keep the installed driver app on the current build without the driver doing anything.
 *
 * Three things conspire against a PWA on a phone: it is installed and left open for
 * days, nothing ever re-fetches index.html, and the plugin's injected registration only
 * ever calls register() — it never asks for an update and never notices one arriving.
 * The result was drivers signing out and back in to "fix" the app, which was never what
 * fixed it, and Jason on 6 Oct looking at a tab bar from before his program existed.
 *
 * So registration lives here and does three things the one-liner did not:
 *
 *  1. Asks the browser to check for a new worker every time the app comes to the
 *     foreground. Picking the phone up is exactly when a deploy since last time matters.
 *  2. Reloads the page when a new worker takes control (`controllerchange`). On Chrome
 *     and Android the worker itself navigates the tab (public/sw-reload.js); Safari has
 *     no WindowClient.navigate, so it posts a message and this is what answers it.
 *  3. Never reloads the scanner. Captured pages sit in memory until they are sent.
 *
 * Only on driver routes. The staff app has its own banner and asks first, on purpose.
 *
 * The policy is a pure function so it can be tested without a browser; the wiring is
 * kept to the thin shell around it.
 */
import { registerSW } from 'virtual:pwa-register'

/** Routes holding unsaved work in memory. A reload here throws a driver's scan away. */
const UNSAFE_PREFIXES = ['/driver/scan']

/** Should a page at this path reload to pick up a new build? */
export function shouldReloadForUpdate(pathname: string): boolean {
  if (!pathname.startsWith('/driver')) return false
  return !UNSAFE_PREFIXES.some((p) => pathname.startsWith(p))
}

/** What the worker posts to a client it could not navigate itself (Safari). */
export const SW_UPDATED_MESSAGE = 'BCAT_SW_UPDATED'

let registered = false

/**
 * Register the driver app's service worker and wire the update behaviour.
 *
 * Idempotent, so a hot reload in development or a second import cannot stack listeners.
 * Does nothing outside the driver app, and nothing where there is no service worker API.
 */
export function registerDriverServiceWorker(win: Window = window): void {
  if (registered) return
  if (!win.location.pathname.startsWith('/driver')) return
  if (!('serviceWorker' in win.navigator)) return
  registered = true

  const reloadIfSafe = () => {
    if (shouldReloadForUpdate(win.location.pathname)) win.location.reload()
  }

  // A new worker has taken control of this page: the code on screen is now older than
  // the code that will serve the next load, so take that load now.
  win.navigator.serviceWorker.addEventListener('controllerchange', reloadIfSafe)

  // Safari's path: the worker could not navigate us, so it asked.
  win.navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    if ((event.data as { type?: string } | null)?.type === SW_UPDATED_MESSAGE) reloadIfSafe()
  })

  registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      if (!registration) return
      // Foreground = somebody just picked the phone up. Cheapest moment to look, and
      // the one where a deploy since last time actually matters to them.
      win.document.addEventListener('visibilitychange', () => {
        if (win.document.visibilityState === 'visible') void registration.update()
      })
    },
  })
}
