import { notifyApptNeeded, createApptMoveTask, updateIntakeItem } from './apiClient'
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
  /** Per-stop follow-up patches earned by the notices (task ids, cleared flags). */
  const patches = new Map<string, Partial<Stop>>()
  const addPatch = (stopId: string, p: Partial<Stop>) =>
    patches.set(stopId, { ...(patches.get(stopId) ?? {}), ...p })

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
    if ((n.kind === 'needed' || (n.kind === 'move' && !n.threadTs)) && ts) started.push({ stopId: n.stopId, ts })

    // NEEDS TO BE MOVED → a task lands on Dennis's queue. Failure to create it must
    // not lose the Slack alert (already sent), so it degrades to a console error.
    if (n.kind === 'move') {
      try {
        const task = await createApptMoveTask({
          loadId: load.id, stopId: n.stopId, stopKind: n.stopKind,
          aljexId: load.aljexId ?? null, pickupNumber: load.pickupNumber ?? null,
          customer: load.customer ?? null,
          location: [stop?.name, stop?.city].filter(Boolean).join(', ') || null,
          apptLabel: n.apptLabel, actorName: actorName ?? null,
        })
        addPatch(n.stopId, { apptMoveTaskId: task.id })
      } catch (err) {
        console.error('[sendApptNotices] could not create the move task', err)
      }
    }

    // Appointment changed (or the request was withdrawn): the task is done, and the
    // flag comes off the stop so the queue stops showing MOVE.
    if (n.kind === 'moved') {
      addPatch(n.stopId, { apptMoveRequested: false, apptMoveTaskId: null })
      if (n.moveTaskId) {
        try { await updateIntakeItem(n.moveTaskId, { status: 'DONE' }) }
        catch (err) { console.error('[sendApptNotices] could not close the move task', err) }
      }
    }
  }

  if (started.length === 0 && patches.size === 0) return

  // Only loads with a real stops array can remember a thread. Writing one onto a legacy
  // load would migrate it as a side effect of a Slack post, which is not this function's
  // business — those simply post at top level next time.
  if (!Array.isArray(load.stops) || load.stops.length === 0) return

  const tsById = new Map(started.map((s) => [s.stopId, s.ts]))
  const stops = next.map((s) => {
    const ts = tsById.get(s.id)
    const patch = patches.get(s.id)
    if (!ts && !patch) return s
    return { ...s, ...(patch ?? {}), ...(ts ? { apptThreadTs: ts } : {}) }
  })
  try {
    await updateLoad(load.id, { stops })
  } catch (err) {
    console.error('[sendApptNotices] could not persist Slack thread ts / task refs', err)
  }
}
