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

/** Short name for a staff email ("jenny@bcatcorp.com" → "Jenny"); Slack-only users show their id. */
export function staffName(email: string | null | undefined): string {
  if (!email) return ''
  const local = email.replace(/^slack:/, '').split('@')[0]
  return local.charAt(0).toUpperCase() + local.slice(1)
}

/** Who sent an outbound message and from where, as the bubble shows it. */
export function senderLabel(m: Pick<DispatchMessage, 'direction' | 'sentBy' | 'via'>, me: string | null | undefined): string | null {
  if (m.direction !== 'OUT') return null
  // Always the person's name, so when several people work the page everyone can see who
  // answered — "(you)" marks your own without hiding the name from the others.
  const who = staffName(m.sentBy) || 'BCAT Ops'
  const name = m.sentBy && me && m.sentBy.toLowerCase() === me.toLowerCase() ? `${who} (you)` : who
  return m.via === 'slack' ? `${name} via Slack` : name
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

/**
 * The files in a paste or a drop. A screenshot on the clipboard arrives as an item with
 * no useful name ("image.png" at best), so each gets a name the thread and the driver's
 * phone can show. Text on the clipboard yields nothing here and pastes as text as usual.
 */
export function filesFromTransfer(items: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null | undefined, at = new Date()): File[] {
  const out: File[] = []
  if (!items) return out
  const stamp = at.toISOString().replace(/[-:]/g, '').slice(0, 15)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind !== 'file') continue
    const f = it.getAsFile()
    if (!f) continue
    const named = /^(image\.(png|jpe?g|gif|webp)|blob|)$/i.test(f.name) || !f.name
    if (!named) { out.push(f); continue }
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
    out.push(new File([f], `pasted-${stamp}-${out.length + 1}.${ext}`, { type: f.type, lastModified: f.lastModified }))
  }
  return out
}
