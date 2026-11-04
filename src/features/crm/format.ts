import type { CrmActivityKind } from '@/lib/crm/types'

export const CRM_KIND_LABEL: Record<CrmActivityKind | string, string> = {
  EMAIL_IN: 'E-mail in',
  EMAIL_OUT: 'E-mail out',
  QUOTE_DRAFTED: 'Quote drafted',
  QUOTE_SENT: 'Quote sent',
  QUOTE_SENT_DERIVED: 'Quote sent',
  QUOTE_CREATED: 'Quote created',
  QUOTE_WON: 'Quote won',
  QUOTE_LOST: 'Quote lost',
  SHIPMENT_CREATED: 'Shipment created',
  STAGE_CHANGE: 'Stage change',
  CALL: 'Call',
  TEXT: 'Text',
  NOTE: 'Note',
  TASK: 'Task',
}

export function kindLabel(kind: string | null | undefined): string {
  return kind ? (CRM_KIND_LABEL[kind] ?? kind) : '—'
}

const DAY = 86_400_000

/** "today", "3d ago", "in 2d" — relative to `now`; empty/invalid input prints a dash. */
export function relativeDay(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const days = Math.floor(now.getTime() / DAY) - Math.floor(t / DAY)
  if (days === 0) return 'today'
  return days > 0 ? `${days}d ago` : `in ${-days}d`
}

/** A due date is overdue once its calendar day is before today (UTC days, as `relativeDay`). */
export function isOverdue(iso: string | null | undefined, now: Date = new Date()): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  return Math.floor(t / DAY) < Math.floor(now.getTime() / DAY)
}

/** `<input type="date">` value (YYYY-MM-DD) to an ISO instant at noon UTC, so no timezone shifts the day. */
export function dateInputToIso(value: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00.000Z` : undefined
}

export function isoToDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : ''
}

/** Managers, admins and the owner see every account (§5.6); everyone else sees their own and unowned. */
export function isCrmManager(auth: { isAdmin: boolean; isOwner?: boolean; user: { groups?: string[] } | null }): boolean {
  return auth.isAdmin || auth.isOwner === true || (auth.user?.groups ?? []).includes('role-MANAGER')
}
