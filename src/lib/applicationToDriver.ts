/**
 * Filling in a driver record from their submitted application.
 *
 * A driver invited to apply starts as a stub: a name derived from their email address
 * and no phone. Their application carries the real details, and until now those stayed
 * inside the application — so the roster kept showing "zak pace" from zak.pace@… and an
 * empty phone column, and somebody had to retype what the driver had already given us.
 *
 * The mapping is deliberately CONSERVATIVE: it only fills gaps. Anything a person has
 * already entered wins, because the office may have corrected something the applicant
 * typed wrong, and a later application submission must not silently undo that.
 */
import type { Driver, DriverApplicationRecord } from '@/types'

/** The stub name the invite generates from an email address. */
export function placeholderNameFor(email: string): string {
  return email.trim().split('@')[0].replace(/[._-]+/g, ' ')
}

/**
 * True when the record still carries the generated stub rather than a real name.
 * Compared case-insensitively, since the stub is stored as typed.
 */
export function isPlaceholderName(name: string | null | undefined, email: string | null | undefined): boolean {
  const n = name?.trim().toLowerCase()
  if (!n) return true
  if (!email?.trim()) return false
  return n === placeholderNameFor(email).toLowerCase()
}

/** The CDL number as it should read on the driver record, including the issuing state. */
export function formatCdl(app: Pick<DriverApplicationRecord, 'cdlNumber' | 'cdlState' | 'cdlClass'>): string {
  const cls = app.cdlClass?.trim()
  const state = app.cdlState?.trim()
  const num = app.cdlNumber?.trim()
  if (!num) return ''
  // "CDL-A IL-8823901" — the shape already used elsewhere in the app.
  const prefix = cls ? `CDL-${cls.replace(/^class\s*/i, '').toUpperCase()} ` : ''
  return `${prefix}${state ? `${state.toUpperCase()}-` : ''}${num}`
}

/**
 * What to write onto the driver record from an approved application.
 *
 * Returns an empty object when there is nothing to fill, so callers can skip the write
 * entirely rather than issuing a no-op mutation.
 */
export function driverPatchFromApplication(
  app: DriverApplicationRecord,
  driver: Pick<Driver, 'name' | 'email' | 'phone' | 'cdl' | 'cdlExpiration'>,
): Partial<Pick<Driver, 'name' | 'phone' | 'cdl' | 'cdlExpiration'>> {
  const patch: Partial<Pick<Driver, 'name' | 'phone' | 'cdl' | 'cdlExpiration'>> = {}

  // The legal name replaces the generated stub, but never a name someone typed.
  const legal = app.legalName?.trim()
  if (legal && isPlaceholderName(driver.name, driver.email)) patch.name = legal

  const phone = app.phone?.trim()
  if (phone && !driver.phone?.trim()) patch.phone = phone

  const cdl = formatCdl(app)
  if (cdl && !driver.cdl?.trim()) patch.cdl = cdl

  const exp = app.cdlExpiration?.slice(0, 10)
  if (exp && !driver.cdlExpiration?.trim()) patch.cdlExpiration = exp

  return patch
}
