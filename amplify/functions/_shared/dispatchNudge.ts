/**
 * The "nobody has answered the driver" escalation, as a pure plan.
 *
 * A driver's text sits unread for 10 minutes → DM the conversation's primary dispatcher
 * (else the driver file's, else the backup). Ten more minutes → DM the backup. Nothing
 * fires twice for the same message, and anything the office does (reply, mark read)
 * resets it. The scheduler runs every five minutes, so timings are "at least".
 */
import { conversationTitle, dispatchersOf, type DispatchConversation, type DispatchDriver } from '../../../src/lib/dispatch'

export const FIRST_NUDGE_MIN = 10
export const SECOND_NUDGE_MIN = 20
export const DISPATCH_URL = 'https://ops.bcatcorp.com/dispatch'

export interface NudgePlan {
  stage: 1 | 2
  /** Staff email to DM. */
  to: string
  text: string
  /** The lastMessageAt this nudge is for, recorded on the row so it never repeats. */
  forAt: string
}

export function nudgeFor(c: DispatchConversation, driver: DispatchDriver | null | undefined, nowMs: number): NudgePlan | null {
  if (c.status === 'ARCHIVED') return null
  if (c.lastDirection !== 'IN' || (c.unreadCount ?? 0) <= 0 || !c.lastMessageAt) return null
  if (c.lastKind === 'STATUS') return null   // a status update is not a question
  const ageMin = (nowMs - Date.parse(c.lastMessageAt)) / 60_000
  if (!Number.isFinite(ageMin) || ageMin < FIRST_NUDGE_MIN) return null
  const stage = c.nudgedFor === c.lastMessageAt ? (c.nudgeStage ?? 0) : 0
  const fromFile = dispatchersOf(driver)
  const primary = c.assignedTo || fromFile[0] || null
  const backup = (c.assignedBackup || fromFile[1] || null)
  const who = conversationTitle(c)
  const waited = `${Math.floor(ageMin)} min`
  const preview = c.lastPreview ? ` “${c.lastPreview}”` : ''
  if (stage === 0) {
    const to = primary ?? backup
    if (!to) return null
    return { stage: 1, to, forAt: c.lastMessageAt, text: `⏱️ *${who}* texted dispatch ${waited} ago and nobody has answered:${preview}\n${DISPATCH_URL}` }
  }
  if (stage === 1 && ageMin >= SECOND_NUDGE_MIN) {
    const to = backup && backup !== primary ? backup : null
    if (!to) return null
    return { stage: 2, to, forAt: c.lastMessageAt, text: `⏱️ Still unanswered after ${waited}: *${who}* texted dispatch${preview}\n(You are the backup${primary ? ` for ${primary}` : ''}.)\n${DISPATCH_URL}` }
  }
  return null
}
