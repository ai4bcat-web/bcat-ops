/**
 * Presentation rules for the Dispatch page, kept pure so they are testable: how a time
 * reads in the list, how a thread splits into days, what a delivery status says.
 */
import type { DispatchMessage } from '@/lib/dispatch'

const CHICAGO = 'America/Chicago'

function sameDay(a: Date, b: Date): boolean {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: CHICAGO, year: 'numeric', month: '2-digit', day: '2-digit' })
  return f.format(a) === f.format(b)
}

/** "2:14 PM" today, "Thu" this week, else "Oct 3". For the conversation list. */
export function listTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (sameDay(d, now)) return d.toLocaleTimeString('en-US', { timeZone: CHICAGO, hour: 'numeric', minute: '2-digit' })
  const days = (now.getTime() - d.getTime()) / 86_400_000
  if (days < 6) return d.toLocaleDateString('en-US', { timeZone: CHICAGO, weekday: 'short' })
  return d.toLocaleDateString('en-US', { timeZone: CHICAGO, month: 'short', day: 'numeric' })
}

/** "2:14 PM" for a bubble. */
export function bubbleTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { timeZone: CHICAGO, hour: 'numeric', minute: '2-digit' })
}

/** "Today", "Yesterday", or "Thursday, Oct 2" for a day divider. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (sameDay(d, now)) return 'Today'
  if (sameDay(d, new Date(now.getTime() - 86_400_000))) return 'Yesterday'
  return d.toLocaleDateString('en-US', { timeZone: CHICAGO, weekday: 'long', month: 'short', day: 'numeric' })
}

export interface DayGroup { key: string; label: string; messages: DispatchMessage[] }

/** A thread split into days, in reading order. */
export function groupByDay(messages: readonly DispatchMessage[], now: Date = new Date()): DayGroup[] {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: CHICAGO, year: 'numeric', month: '2-digit', day: '2-digit' })
  const groups: DayGroup[] = []
  for (const m of messages) {
    const key = f.format(new Date(m.at))
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.messages.push(m)
    else groups.push({ key, label: dayLabel(m.at, now), messages: [m] })
  }
  return groups
}

export type DeliveryTone = 'muted' | 'ok' | 'bad' | 'pending'

/** What a sent message's status line says, and how loudly. */
export function deliveryLabel(m: Pick<DispatchMessage, 'direction' | 'kind' | 'status' | 'errorMessage' | 'errorCode'>): { text: string; tone: DeliveryTone } | null {
  if (m.direction !== 'OUT' || m.kind === 'NOTE') return null
  switch (m.status) {
    case 'delivered': return { text: 'Delivered', tone: 'ok' }
    case 'read': return { text: 'Read', tone: 'ok' }
    case 'sent': return { text: 'Sent', tone: 'muted' }
    case 'queued':
    case 'accepted':
    case 'sending': return { text: 'Sending…', tone: 'pending' }
    case 'failed':
    case 'undelivered':
    case 'canceled': return { text: `Not delivered. ${m.errorMessage ?? (m.errorCode ? `Twilio error ${m.errorCode}.` : '')}`.trim(), tone: 'bad' }
    default: return m.status ? { text: m.status, tone: 'muted' } : null
  }
}

/** Short name for the signed-in person's email, for "you" vs a teammate. */
export function staffName(email: string | null | undefined): string {
  if (!email) return ''
  const local = email.split('@')[0]
  return local.charAt(0).toUpperCase() + local.slice(1)
}

export const MAX_UPLOAD_FILES = 5
export const ACCEPTED_MEDIA = 'image/jpeg,image/png,image/gif,image/webp,image/heic,application/pdf'

/** Pick out what can be sent as MMS, naming what was dropped. */
export function acceptFiles(files: readonly File[], existing = 0): { ok: File[]; rejected: string[] } {
  const ok: File[] = []
  const rejected: string[] = []
  const allowed = ACCEPTED_MEDIA.split(',')
  for (const f of files) {
    if (ok.length + existing >= MAX_UPLOAD_FILES) { rejected.push(`${f.name} (limit ${MAX_UPLOAD_FILES} per text)`); continue }
    if (!allowed.includes(f.type)) { rejected.push(`${f.name} (only pictures and PDFs)`); continue }
    if (f.size > 5 * 1024 * 1024) { rejected.push(`${f.name} (over 5 MB)`); continue }
    ok.push(f)
  }
  return { ok, rejected }
}
