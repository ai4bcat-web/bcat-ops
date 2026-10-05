/**
 * Deriving the staff Ivan Driver App view. Pure — no store, no clock, no fetch.
 *
 * Mirrors the driver's own page so the two cannot disagree about what is outstanding, and
 * carries the same restriction: no rate on a load. Staff can see rates in a dozen other
 * places; this page exists to answer "whose paperwork is missing", and putting money on it
 * would only invite it to be read as a settlement, which Ivan's drivers do not have.
 */
import { driverGroupOf } from '@/lib/calendarDrivers'
import { driverProgramOf } from '@/lib/driverProgram'
import { loadDriverIds } from '@/lib/calendarDrivers'
import { weekStartOfISO } from '@/features/driver-pay/week'
import type { Driver, Load } from '@/types'

export type PodState = 'MISSING' | 'ILLEGIBLE' | 'OK'

export interface PaperworkDocLike {
  loadId?: string | null
  referenceNumber?: string | null
  docs: Array<{
    kind: string
    legibility?: string | null
    legibilityNotes?: string | null
    /** ISO. The earliest POD page is what the staff table reports. */
    uploadedAt?: string | null
  }>
}

export interface IvanLoadRow {
  load: Load
  reference: string
  podState: PodState
  podPages: number
  podNotes: string | null
  /** When the POD arrived, ISO, or null. Earliest page wins. */
  podUploadedAt: string | null
}

export interface IvanDriverRow {
  driver: Driver
  loads: IvanLoadRow[]
  podsMissing: number
  podsIllegible: number
  /**
   * True when this driver will NOT actually get the paperwork app, because their record
   * says nothing about which fleet they run in. The dispatch board calls them Ivan's; the
   * driver app keeps their settlement rather than guessing. Surfaced so somebody can set
   * the fleet rather than wondering why the invite led to the wrong page.
   */
  unclassified: boolean
}

function normalizePro(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw || raw.toUpperCase() === 'N/A') return null
  const key = raw.replace(/^\s*pro\s*#?\s*/i, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return key.length >= 3 ? key : null
}

/** Worst page wins — a POD is only as readable as its least readable sheet. */
export function podStateOf(
  load: Load,
  submissions: PaperworkDocLike[],
): { state: PodState; pages: number; notes: string | null; uploadedAt: string | null } {
  const pro = normalizePro(load.aljexId)
  const mine = submissions.filter(
    (s) => (s.loadId && s.loadId === load.id) || (pro && normalizePro(s.referenceNumber) === pro),
  )
  const pages = mine.flatMap((s) => s.docs.filter((d) => (d.kind ?? '').toUpperCase() === 'POD'))
  if (pages.length === 0) return { state: 'MISSING', pages: 0, notes: null, uploadedAt: null }
  const bad = pages.find((d) => d.legibility === 'UNREADABLE' || d.legibility === 'LOW')
  // Earliest page: a POD re-sent today should not make a load papered last week look late.
  const uploadedAt = pages.map((d) => (d.uploadedAt ?? '').trim()).filter(Boolean).sort()[0] ?? null
  return {
    state: bad ? 'ILLEGIBLE' : 'OK',
    pages: pages.length,
    notes: bad?.legibilityNotes?.trim() || null,
    uploadedAt,
  }
}

/** Drivers this page is about: Ivan's own, as the dispatch board defines them. */
export function ivanDrivers(drivers: Driver[]): Driver[] {
  return drivers
    .filter((d) => d.active !== false && d.type !== 'broker' && driverGroupOf(d) === 'IVAN')
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function buildIvanDriverApp(input: {
  drivers: Driver[]
  loads: Load[]
  submissions: PaperworkDocLike[]
  weekStart: string
}): IvanDriverRow[] {
  const { drivers, loads, submissions, weekStart } = input

  // Delivered in this pay week, keyed the same way the driver's own page keys it.
  const inWeek = loads.filter((l) => {
    const appt = (l.deliveryAppt ?? '').slice(0, 10)
    return !!appt && weekStartOfISO(appt) === weekStart
  })

  return ivanDrivers(drivers).map((driver) => {
    const mine = inWeek
      .filter((l) => loadDriverIds(l).includes(driver.id))
      .sort((a, b) => String(a.deliveryAppt ?? '').localeCompare(String(b.deliveryAppt ?? '')))

    const rows: IvanLoadRow[] = mine.map((load) => {
      const pod = podStateOf(load, submissions)
      return {
        load,
        reference: (load.aljexId ?? '').trim() || (load.tmsId ?? '').trim() || load.id,
        podState: pod.state,
        podPages: pod.pages,
        podNotes: pod.notes,
        podUploadedAt: pod.uploadedAt,
      }
    })

    return {
      driver,
      loads: rows,
      podsMissing: rows.filter((r) => r.podState === 'MISSING').length,
      podsIllegible: rows.filter((r) => r.podState === 'ILLEGIBLE').length,
      unclassified: driverProgramOf(driver) !== 'PAPERWORK',
    }
  })
}
