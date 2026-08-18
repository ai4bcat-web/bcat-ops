import { notifyApptNeeded } from './apiClient'
import { apptNotices } from './apptNotify'
import { formatDateShort } from './date'
import type { Load, Stop } from '@/types'

/**
 * Post the Slack notices a save earned, and remember the threads they started.
 *
 * One place, called by every editor. The Loads drawer used to be the only caller, so
 * flagging NEED from the calendar was silent — that gap is what happens when each call
 * site decides for itself whether to notify.
 *
 * Fire-and-forget by contract: notifyApptNeeded swallows its own errors, and a failed
 * thread-ts write only costs a future reply its thread. Nothing here may reject into a
 * save path.
 */
export async function sendApptNotices({ load, next, prev, actorName, updateLoad }: {
  load: Load
  /** Stops as just saved. */
  next: Stop[]
  /** Stops as they were before this save. */
  prev: Stop[]
  actorName?: string | null
  updateLoad: (id: string, patch: Partial<Load>) => Promise<unknown>
}): Promise<void> {
  const notices = apptNotices(next, prev)
  if (notices.length === 0) return

  const byId = new Map(next.map((s) => [s.id, s]))
  const started: { stopId: string; ts: string }[] = []

  for (const n of notices) {
    const stop = byId.get(n.stopId)
    const ts = await notifyApptNeeded({
      stopKind: n.stopKind,
      kind: n.kind,
      threadTs: n.threadTs ?? null,
      apptLabel: n.apptLabel,
      aljexId: load.aljexId,
      pickupNumber: load.pickupNumber,
      customer: load.customer ?? null,
      location: [stop?.name, stop?.city].filter(Boolean).join(', ') || null,
      apptDate: stop?.appt ? formatDateShort(stop.appt) : null,
      actorName: actorName ?? null,
    })
    if (n.kind === 'needed' && ts) started.push({ stopId: n.stopId, ts })
  }

  if (started.length === 0) return

  // Only loads with a real stops array can remember a thread. Writing one onto a legacy
  // load would migrate it as a side effect of a Slack post, which is not this function's
  // business — those simply post at top level next time.
  if (!Array.isArray(load.stops) || load.stops.length === 0) return

  const tsById = new Map(started.map((s) => [s.stopId, s.ts]))
  const stops = next.map((s) => {
    const ts = tsById.get(s.id)
    return ts ? { ...s, apptThreadTs: ts } : s
  })
  try {
    await updateLoad(load.id, { stops })
  } catch (err) {
    console.error('[sendApptNotices] could not persist Slack thread ts', err)
  }
}
