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
import { fetchMe, type DriverPm, type DriverProfile } from './driverApi'
import type { DriverProgram } from '@/lib/driverProgram'

let cached: DriverProgram | null = null
/*
 * The rest of the profile from the same call.
 *
 * Kept beside the program so the PM line does not cost a second /me on every launch — it
 * rides along on the request the shell already makes. Separate from `cached` because the
 * program has a fail-safe default and the profile does not: a failed call leaves this null,
 * which reads as "nothing to show" rather than a made-up truck.
 */
let cachedProfile: DriverProfile | null = null

/** Cleared on sign-out so the next driver on this device is not given the last one's page. */
export function clearCachedProgram(): void {
  cached = null
  cachedProfile = null
}

/**
 * This driver's truck PM line, or null when there is nothing to say.
 *
 * Null covers every quiet case — no truck assigned, the profile call failed, an API that
 * predates the field — because all of them mean the same thing to the screen.
 */
export function useDriverPm(): DriverPm | null {
  const [pm, setPm] = useState<DriverPm | null>(cachedProfile?.pm ?? null)

  useEffect(() => {
    // Already cached: useState above took it at mount, so there is nothing to set here.
    // Setting it anyway is a synchronous setState inside an effect, which cascades renders.
    if (cachedProfile) return
    let stale = false
    fetchMe()
      .then((me) => {
        cachedProfile = me
        if (!stale) setPm(me.pm ?? null)
      })
      .catch(() => { /* the PM line is a nicety; a failed call simply shows nothing */ })
    return () => { stale = true }
  }, [])

  return pm
}

export function useDriverProgram(): DriverProgram | null {
  const [program, setProgram] = useState<DriverProgram | null>(cached)

  useEffect(() => {
    if (cached) return
    let stale = false
    fetchMe()
      .then((me) => {
        cachedProfile = me
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
