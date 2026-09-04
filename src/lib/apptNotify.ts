import { apptTimeLabel, formatDateShort } from './date'
import type { Stop, StopType } from '@/types'

/**
 * Deciding what to tell #appts-ivan after a save.
 *
 * Kept as a pure function over (before, after) stops so every editor — the calendar
 * popover, the Loads drawer, the Appts queue — asks the same question and gets the same
 * answer. Previously only the Loads drawer notified at all, so flagging NEED from the
 * calendar was silent; that is the kind of gap that appears when three call sites each
 * decide for themselves.
 */

export type ApptNoticeKind = 'needed' | 'updated' | 'move' | 'moved'

export interface ApptNotice {
  kind: ApptNoticeKind
  stopId: string
  stopKind: StopType
  /** For 'moved': the open move-task to mark DONE. */
  moveTaskId?: string | null
  /** Reply in this Slack thread; absent means post a new top-level message. */
  threadTs?: string
  /**
   * The new appointment as a person would read it, e.g. "Aug 20 · 09:30".
   *
   * Carries the DATE as well as the time label: on its own a NEED stop labels as bare
   * "NEED", and a Slack reply reading "appt updated — NEED" tells the reader nothing.
   */
  apptLabel: string
}

const key = (s: Stop) => s.apptType ?? 'exact'

const describe = (s: Stop): string => {
  const time = apptTimeLabel(s.appt, s.apptType, s.apptEnd)
  return s.appt ? `${formatDateShort(s.appt)} · ${time}` : time
}

/**
 * One notice per stop, at most.
 *
 *  - `needed`  — the stop just became NEED. Somebody has to go book it.
 *  - `updated` — the appointment moved on a stop we have already asked about, so the
 *                thread that asked deserves the answer.
 *
 * A stop that becomes NEED yields `needed`, never both: the new post already says what
 * changed, so a second "the time moved" reply would be noise.
 *
 * `updated` requires an existing thread. Without one there is no conversation to update,
 * and posting every appointment change to the channel would turn a signal into a feed —
 * which is the failure mode that makes people mute it. The one exception is a stop that
 * is STILL NEED when its requested time changes: that always notifies (in-thread when
 * there is a thread, otherwise as a new post), because the person booking it needs the
 * new time either way.
 */
export function apptNotices(next: Stop[], prev: Stop[] = []): ApptNotice[] {
  const before = new Map(prev.map((s) => [s.id, s]))
  const out: ApptNotice[] = []

  for (const s of next) {
    const was = before.get(s.id)
    const label = describe(s)

    // Newly NEED — including a brand-new stop authored as NEED.
    if (key(s) === 'tbd' && (!was || key(was) !== 'tbd')) {
      out.push({ kind: 'needed', stopId: s.id, stopKind: s.type, apptLabel: label })
      continue
    }

    // Newly flagged NEEDS TO BE MOVED: alert the channel (in-thread when one exists)
    // and let the sender open the Dennis task. One notice — not also an 'updated'.
    if (s.apptMoveRequested && !was?.apptMoveRequested) {
      out.push({ kind: 'move', stopId: s.id, stopKind: s.type, threadTs: s.apptThreadTs, apptLabel: label })
      continue
    }

    if (!was) continue

    // The move request is being RESOLVED — the appointment changed (or the flag was
    // cleared by hand). Reply in the thread and close the task.
    const apptMoved =
      s.appt !== was.appt || (s.apptEnd ?? '') !== (was.apptEnd ?? '') || key(s) !== key(was)
    if (was.apptMoveRequested && (apptMoved || !s.apptMoveRequested)) {
      out.push({
        kind: 'moved', stopId: s.id, stopKind: s.type,
        threadTs: s.apptThreadTs, apptLabel: label, moveTaskId: was.apptMoveTaskId ?? null,
      })
      continue
    }
    if (s.apptMoveRequested) continue // still flagged, nothing new — stay quiet

    // The appointment itself moved: a different instant, a different window, or the type
    // changed (NEED → a real booking is exactly what the thread was waiting to hear).
    const moved =
      s.appt !== was.appt || (s.apptEnd ?? '') !== (was.apptEnd ?? '') || key(s) !== key(was)
    if (!moved) continue

    if (s.apptThreadTs) {
      out.push({
        kind: 'updated', stopId: s.id, stopKind: s.type,
        threadTs: s.apptThreadTs, apptLabel: label,
      })
      continue
    }

    // Still NEED and the requested date/time changed, but no thread to reply in (legacy
    // load, or the original post never got its ts back): the booker still has to hear
    // about it, so post fresh. Stops that are NOT need-flagged stay quiet without a thread.
    if (key(s) === 'tbd') {
      out.push({ kind: 'needed', stopId: s.id, stopKind: s.type, apptLabel: label })
    }
  }

  return out
}
