/**
 * Step AG §7.2 — the one calm line shown above every AP tab and on the Settings card, so the two
 * always agree. Pure.
 */
import type { ApConnectionStatus, ApRunDigest } from './types'

export interface DigestInput {
  connection: ApConnectionStatus
  /** Newest run, if any. */
  run: ApRunDigest | null
  /** Items currently in NEEDS_REVIEW. */
  openCount: number
  /** Current instant (for "today" / "yesterday"). */
  now: Date
  /** The configured daily run hour (Chicago) for the "never run" line. */
  runHourChicago?: number
}

export interface DigestLine {
  tone: 'ok' | 'warn' | 'info'
  text: string
}

const TZ = 'America/Chicago'
const dayKey = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

function whenText(at: Date, now: Date): string {
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(at)
  const today = dayKey(now)
  if (dayKey(at) === today) return `today ${time}`
  if (dayKey(at) === dayKey(new Date(now.getTime() - 86_400_000))) return `yesterday ${time}`
  const date = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(at)
  return `${date} ${time}`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function hourText(h: number): string {
  const suffix = h < 12 ? 'AM' : 'PM'
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${suffix}`
}

export function formatDigest(input: DigestInput): DigestLine {
  const { connection, run, openCount, now } = input
  if (connection === 'NOT_CONNECTED' || connection === 'PENDING') {
    return { tone: 'info', text: 'AP inbox is not connected. An admin connects it under Settings → General & automation → Accounting · AP inbox.' }
  }
  if (connection === 'NEEDS_RECONNECT') {
    return { tone: 'warn', text: 'Google no longer accepts the AP inbox connection — an admin needs to reconnect it.' }
  }
  if (!run) {
    return { tone: 'info', text: `AP inbox is connected — first review runs at ${hourText(input.runHourChicago ?? 6)}, or press Review now.` }
  }
  const ended = new Date(run.endedAt || run.startedAt)
  const when = Number.isNaN(ended.getTime()) ? '' : ` ${whenText(ended, now)}`
  if (run.error === 'AGENT_DISABLED') return { tone: 'warn', text: `AP inbox · paused — the AP agent is switched off under Settings → AI agents.` }
  if (run.error === 'NOT_CONFIGURED') return { tone: 'warn', text: 'AP inbox · the Google client is not set up under Settings → Integrations → Google.' }
  if (run.error === 'NEEDS_RECONNECT') {
    return { tone: 'warn', text: 'Google no longer accepts the AP inbox connection — an admin needs to reconnect it.' }
  }
  let text = `AP inbox ·${when} — reviewed ${plural(run.reviewed, 'e-mail', 'e-mails')}, updated ${plural(run.updatedBills, 'bill', 'bills')}, ${run.needReview} need review`
  if (run.errors > 0 || run.abandoned > 0) text += `, ${run.errors + run.abandoned} could not be read`
  if (run.partial) text += ' (stopped early; continues at the next hourly check)'
  if (openCount > 0) text += ` (${openCount} open in the queue)`
  return { tone: run.errors + run.abandoned > 0 || run.partial ? 'warn' : 'ok', text }
}
