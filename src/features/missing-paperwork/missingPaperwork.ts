/**
 * Loads that delivered without paperwork — and the paperwork that arrived without a load.
 *
 * Both halves, on one page, because in this data they are the same problem seen from two
 * ends. Measured on 2026-10-04: 683 loads had a delivery appointment in the past, 670 of
 * them had no POD from either store — and 101 of the 102 PODs JobsDone had received were
 * sitting unassigned to any load. The paperwork largely EXISTS. A page that listed only
 * the empty loads would send somebody chasing drivers for documents already in the system.
 *
 * ON "DELIVERED": there is no delivery event to read. No load in the table carries a
 * `status`, none has a stops array, and so nothing records an actual arrival or departure.
 * The only available signal is that the delivery APPOINTMENT has passed, which is an
 * inference: a load whose appointment went by may have been rescheduled or rolled. The UI
 * says so rather than claiming the load delivered.
 *
 * Pure: loads, documents and an `asOf` in; rows out. No store, no clock, no fetch.
 */
import { normalizePro } from '@/lib/podPresence'
import type { Driver, Load } from '@/types'

/** Enough of a POD source to tell whether a load has one. */
export interface PodPresence {
  /** Load ids known to have a POD, from either store. */
  byLoadId: ReadonlySet<string>
  /** Normalized PROs known to have a POD. */
  byPro: ReadonlySet<string>
}

export interface MissingRow {
  load: Load
  /** The PRO, or the row id when there is none. */
  reference: string
  customer: string | null
  lane: string | null
  driverName: string | null
  deliveryAppt: string
  /** Whole days since the delivery appointment. Drives the ordering and the urgency. */
  ageDays: number
}

export type UnmatchedSource = 'JOBSDONE' | 'DRIVER_PWA' | 'STAFF'

export interface UnmatchedDoc {
  id: string
  source: UnmatchedSource
  /** Who sent it: a driver's name, or the phone/email a texted POD came from. */
  from: string | null
  receivedAt: string
  /** The PRO written on it, if any. Blank is the normal case for a texted POD. */
  reference: string | null
  /**
   * The load this PRO points at, when one matches. The whole reason to pair the halves:
   * an unmatched document with a readable PRO is one click from being filed.
   */
  suggestedLoadId: string | null
  suggestedReference: string | null
}

export function daysBetween(fromIso: string, asOf: Date): number {
  const then = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(then)) return 0
  const today = Date.parse(`${asOf.toISOString().slice(0, 10)}T00:00:00Z`)
  return Math.max(0, Math.round((today - then) / 86_400_000))
}

export function loadHasPaperwork(load: Load, pods: PodPresence): boolean {
  if (pods.byLoadId.has(load.id)) return true
  const pro = normalizePro(load.aljexId)
  return pro !== null && pods.byPro.has(pro)
}

function laneOf(load: Load): string | null {
  const parts = [load.originCity, load.destinationCity].map((c) => (c ?? '').trim()).filter(Boolean)
  return parts.length ? parts.join(' → ') : null
}

/**
 * Delivered loads with no POD, oldest first.
 *
 * Oldest first and not newest: a POD missing for two months is the one that has gone cold,
 * and a reverse-chronological list buries it under this week's, which will arrive on its
 * own. `withinDays` keeps the page a work queue rather than the whole load table — with
 * coverage as thin as it is here, no window at all lists 670 rows.
 */
export function deliveredWithoutPaperwork(input: {
  loads: Load[]
  drivers: Driver[]
  pods: PodPresence
  asOf: Date
  /** null means every delivered load, however old. */
  withinDays: number | null
}): MissingRow[] {
  const { loads, drivers, pods, asOf, withinDays } = input
  const today = asOf.toISOString().slice(0, 10)
  const nameById = new Map(drivers.map((d) => [d.id, d.name]))

  return loads
    .filter((l) => {
      const appt = (l.deliveryAppt ?? '').slice(0, 10)
      if (!appt || appt >= today) return false // not yet due: nothing to chase
      if (loadHasPaperwork(l, pods)) return false
      return withinDays === null || daysBetween(appt, asOf) <= withinDays
    })
    .map((l) => ({
      load: l,
      reference: (l.aljexId ?? '').trim() || (l.tmsId ?? '').trim() || l.id,
      customer: (l.customer ?? '').trim() || null,
      lane: laneOf(l),
      driverName: nameById.get(l.deliveryDriverId ?? '') ?? null,
      deliveryAppt: l.deliveryAppt ?? '',
      ageDays: daysBetween((l.deliveryAppt ?? '').slice(0, 10), asOf),
    }))
    .sort((a, b) => b.ageDays - a.ageDays || a.reference.localeCompare(b.reference))
}

/** Paperwork that is in the system but on no load, newest first. */
export function unmatchedPaperwork(input: {
  jobsdone: Array<{ id: string; loadId?: string | null; referenceNumber?: string | null; senderName?: string | null; senderContact?: string | null; receivedAt?: string | null; createdAt?: string | null }>
  submissions: Array<{ id: string; loadId?: string | null; referenceNumber?: string | null; driverName?: string | null; source?: string | null; createdAt: string; docs: Array<{ kind: string }> }>
  loads: Load[]
}): UnmatchedDoc[] {
  const { jobsdone, submissions, loads } = input

  // PRO → load, for suggesting where a document belongs.
  const loadByPro = new Map<string, Load>()
  for (const l of loads) {
    const pro = normalizePro(l.aljexId)
    if (pro && !loadByPro.has(pro)) loadByPro.set(pro, l)
  }
  function suggest(reference: string | null | undefined) {
    const pro = normalizePro(reference)
    const hit = pro ? loadByPro.get(pro) : undefined
    return {
      suggestedLoadId: hit?.id ?? null,
      suggestedReference: hit ? (hit.aljexId ?? '').trim() || hit.id : null,
    }
  }

  const out: UnmatchedDoc[] = []

  for (const d of jobsdone) {
    if (d.loadId) continue
    out.push({
      id: d.id,
      source: 'JOBSDONE',
      from: (d.senderName ?? '').trim() || (d.senderContact ?? '').trim() || null,
      receivedAt: d.receivedAt ?? d.createdAt ?? '',
      reference: (d.referenceNumber ?? '').trim() || null,
      ...suggest(d.referenceNumber),
    })
  }

  for (const s of submissions) {
    if (s.loadId) continue
    // Only a POD counts as missing paperwork; a lone rate confirmation is not what a
    // delivered load is waiting on.
    if (!s.docs.some((x) => (x.kind ?? '').toUpperCase() === 'POD')) continue
    out.push({
      id: s.id,
      source: s.source === 'STAFF' ? 'STAFF' : 'DRIVER_PWA',
      from: (s.driverName ?? '').trim() || null,
      receivedAt: s.createdAt,
      reference: (s.referenceNumber ?? '').trim() || null,
      ...suggest(s.referenceNumber),
    })
  }

  return out.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
}
