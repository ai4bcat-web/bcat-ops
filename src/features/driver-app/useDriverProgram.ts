/**
 * Which program this driver is on, from /me, fetched once per app load and shared.
 *
 * Module-level rather than context so the tab bar, the landing redirect and the scanner
 * all read the same answer without re-fetching, and so a cold relaunch mid-scan (iOS
 * discards the web view behind the file picker) does not race three copies of the call.
 *
 * A FAILED /me is an error, not a default. It used to fall back to SETTLEMENT, which for an
 * Ivan driver meant: the Settlement tab, a settlement page, a 409 "this driver has
 * paperwork, not a settlement", and a Retry button that retried the wrong thing. Jason
 * sat at that screen for a day while the real refusal — whatever it was — never reached
 * anyone. Now the failure is shown as itself, with the server's own message, and Retry
 * retries /me.
 */
import { useEffect, useReducer } from 'react'
import { fetchMe, type DriverPm, type DriverProfile } from './driverApi'
import type { DriverProgram } from '@/lib/driverProgram'

let cached: DriverProgram | null = null
let cachedProfile: DriverProfile | null = null
let lastError: string | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((l) => l())
}

function load(): Promise<void> {
  if (inflight) return inflight
  inflight = fetchMe()
    .then(
      (me) => {
        cachedProfile = me
        cached = me.program ?? 'SETTLEMENT'
        lastError = null
      },
      (err: unknown) => {
        lastError = err instanceof Error && err.message ? err.message : 'Could not load your profile.'
      },
    )
    .finally(() => {
      inflight = null
      notify()
    })
  return inflight
}

/** Forget everything — on sign-out, so the next driver on this phone starts clean. */
export function clearCachedProgram(): void {
  cached = null
  cachedProfile = null
  lastError = null
}

export interface DriverProgramStatus {
  /** null while loading, and when the load failed. */
  program: DriverProgram | null
  /** The server's message when /me failed; null while loading or once it succeeded. */
  error: string | null
  retry: () => void
}

export function useDriverProgramStatus(): DriverProgramStatus {
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    listeners.add(rerender)
    if (!cached && !lastError) void load()
    return () => { listeners.delete(rerender) }
  }, [])

  return {
    program: cached,
    error: cached ? null : lastError,
    retry: () => {
      lastError = null
      notify()
      void load()
    },
  }
}

export function useDriverProgram(): DriverProgram | null {
  return useDriverProgramStatus().program
}

export function useDriverPm(): DriverPm | null {
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    listeners.add(rerender)
    if (!cachedProfile && !lastError) void load()
    return () => { listeners.delete(rerender) }
  }, [])

  // The PM line is a nicety; a failed call simply shows nothing.
  return cachedProfile?.pm ?? null
}
