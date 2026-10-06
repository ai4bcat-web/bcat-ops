/**
 * Put a new build in front of a driver without asking them to do anything.
 *
 * The staff app shows a banner and lets the person choose, because a reload mid-way
 * through a load form throws away their typing. A driver's phone is the opposite case:
 * the app sits installed and open for days, nothing ever re-fetches index.html, and the
 * one way a driver "fixed" a stale app was to sign out and back in — which is both
 * folklore and a nuisance, since signing out was never what updated it.
 *
 * So on driver routes the reload happens by itself, at the one moment it is safe: when
 * the app comes back to the FOREGROUND. Nobody is typing then; they have just picked the
 * phone up. Reloading while they are mid-task would be the staff bug all over again.
 *
 * Two things are never interrupted:
 *
 *  - The scanner. Captured pages live in memory until they are sent, and a reload would
 *    silently bin a POD somebody just photographed at a dock.
 *  - Anything mid-flight. `blockedByWork` lets a screen say "not now"; the update simply
 *    waits for the next time the app is reopened.
 *
 * Nothing is lost by waiting — the next foreground does it.
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppUpdate } from '@/hooks/useAppUpdate'

/** Routes that hold unsaved work in memory and must never be reloaded underneath. */
const UNSAFE = ['/driver/scan']

export function DriverAutoUpdate() {
  const { available, reload } = useAppUpdate()
  const { pathname } = useLocation()

  /*
   * Re-registered whenever the route or the availability changes, so the listener always
   * sees the current values without a ref. Adding and removing one listener is far cheaper
   * than the stale-closure bug the alternative invites.
   */
  useEffect(() => {
    if (!available) return
    if (!pathname.startsWith('/driver')) return
    if (UNSAFE.some((p) => pathname.startsWith(p))) return

    const onVisible = () => {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [available, pathname, reload])

  return null
}
