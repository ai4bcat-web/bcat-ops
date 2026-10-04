/**
 * Which program this driver is on, from the server.
 *
 * Fetched rather than inferred: the client has the driver's token and nothing else, and
 * which fleet someone runs in is the server's to say. Held in a module-level cache so the
 * shell, the landing redirect and the tab bar all read one answer and the app does not ask
 * three times on every launch.
 *
 * `null` means "not known yet" and callers must wait on it — rendering the settlement tab
 * and then swapping it for paperwork a moment later shows an Ivan driver a pay page they
 * are not supposed to have, however briefly.
 */
import { useEffect, useState } from 'react'
import { fetchMe } from './driverApi'
import type { DriverProgram } from '@/lib/driverProgram'

let cached: DriverProgram | null = null

/** Cleared on sign-out so the next driver on this device is not given the last one's page. */
export function clearCachedProgram(): void {
  cached = null
}

export function useDriverProgram(): DriverProgram | null {
  const [program, setProgram] = useState<DriverProgram | null>(cached)

  useEffect(() => {
    if (cached) return
    let stale = false
    fetchMe()
      .then((me) => {
        if (stale) return
        cached = me.program ?? 'SETTLEMENT'
        setProgram(cached)
      })
      .catch(() => {
        /*
         * A driver whose profile call fails still gets their app. Defaulting to the
         * settlement matches driverProgramOf's own fail-safe: never silently take an owner
         * operator's pay page away because one request dropped on a bad connection.
         */
        if (stale) return
        cached = 'SETTLEMENT'
        setProgram(cached)
      })
    return () => { stale = true }
  }, [])

  return program
}
