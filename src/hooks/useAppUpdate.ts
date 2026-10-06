/**
 * Notice when a new build has been deployed, so a long-lived tab stops serving stale code.
 *
 * BCAT Ops is a single-page app. Clicking around the sidebar never re-fetches index.html —
 * the router swaps routes in the browser — so a tab left open since before a deploy keeps
 * running the old JavaScript indefinitely. Everything looks healthy; features simply are not
 * there. That has now cost several rounds of "I still don't see it" over features that were
 * live the whole time, which is exactly the kind of thing that teaches people to distrust
 * what they are told has shipped.
 *
 * Vite stamps a content hash into the bundle filename, so index.html naming a different
 * bundle IS the signal that a deploy happened. index.html is served with max-age=0, so this
 * revalidates cheaply rather than re-downloading anything.
 *
 * It only ever REPORTS. Reloading is the user's choice: a reload that fires while somebody
 * is halfway through a load form loses their work, and silently discarding typing to deliver
 * a nav item nobody was waiting for is a bad trade.
 */
import { useCallback, useEffect, useState } from 'react'

/** Quarter of an hour: deploys are occasional and this must not become background noise. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000

/** The script tags index.html points at, which change on every deploy. */
async function currentBundles(): Promise<string | null> {
  try {
    const res = await fetch('/index.html', { cache: 'no-store' })
    if (!res.ok) return null
    const html = await res.text()
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
    return srcs.length ? srcs.sort().join('|') : null
  } catch {
    // Offline, or the server blinked. Not knowing is not the same as being out of date.
    return null
  }
}

export interface AppUpdate {
  /** A different build is on the server. */
  available: boolean
  /** Fetch the new index.html and everything under it. */
  reload: () => void
}

export function useAppUpdate(): AppUpdate {
  const [baseline, setBaseline] = useState<string | null>(null)
  const [available, setAvailable] = useState(false)

  const reload = useCallback(() => {
    // `location.reload()` can be answered from cache in some browsers; replacing the URL
    // with a fresh one cannot.
    window.location.href = `${window.location.pathname}${window.location.search}${window.location.hash}`
    window.location.reload()
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const check = async () => {
      const seen = await currentBundles()
      if (cancelled || !seen) return
      setBaseline((prev) => {
        if (prev === null) return seen        // first look establishes what we are running
        if (prev !== seen) setAvailable(true)
        return prev                            // keep the original, so the banner stays put
      })
    }

    void check()
    timer = setInterval(() => { void check() }, CHECK_INTERVAL_MS)
    // Coming back to a tab is the moment staleness matters most, and the cheapest time to look.
    const onVisible = () => { if (document.visibilityState === 'visible') void check() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  void baseline
  return { available, reload }
}
