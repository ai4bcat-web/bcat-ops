/**
 * Colours and wording the Empty trucks map, cards and list share, so a red pin, a red chip and a
 * red rank badge mean the same thing. Every colour is a theme token, so light and dark both work.
 */
import type { DeadheadTier, EmptyTruckRow, EmptyUrgency } from './emptyTrucks'

export const URGENCY_COLOR: Record<EmptyUrgency, string> = {
  now: 'var(--tms-badge-red)',
  soon: 'var(--tms-badge-orange)',
  week: 'var(--tms-primary)',
  beyond: 'var(--tms-badge-gray)',
}

export const URGENCY_TINT: Record<EmptyUrgency, string> = {
  now: 'var(--tms-badge-red-tint)',
  soon: 'var(--tms-badge-orange-tint)',
  week: 'var(--tms-primary-tint)',
  beyond: 'var(--tms-badge-gray-tint)',
}

export const URGENCY_LABEL: Record<EmptyUrgency, string> = {
  now: 'Empty now',
  soon: 'Within a day',
  week: 'This week',
  beyond: 'Later',
}

export const TIER_COLOR: Record<DeadheadTier, string> = {
  short: 'var(--tms-badge-green)',
  medium: 'var(--tms-badge-orange)',
  long: 'var(--tms-badge-red)',
  unknown: 'var(--tms-badge-gray)',
}

export const TIER_TINT: Record<DeadheadTier, string> = {
  short: 'var(--tms-badge-green-tint)',
  medium: 'var(--tms-badge-orange-tint)',
  long: 'var(--tms-badge-red-tint)',
  unknown: 'var(--tms-badge-gray-tint)',
}

const TZ = 'America/Chicago'
export const dayText = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(ms)
export const weekdayText = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(ms)
export const clockText = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(ms)
export const whenText = (ms: number, timeKnown: boolean) => (timeKnown ? `${dayText(ms)}, ${clockText(ms)}` : dayText(ms))
export const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`
export const daysText = (n: number) => `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)} day${n === 1 ? '' : 's'}`

export function emptyHeadline(row: EmptyTruckRow, now: number): string {
  if (row.late) return `Past its appointment (${whenText(row.emptyAt, row.timeKnown)}), not marked left`
  if (row.alreadyEmpty) return `Empty since ${whenText(row.emptyAt, row.timeKnown)}`
  const hours = Math.max(0, Math.round((row.emptyAt - now) / 3_600_000))
  const away = hours < 1 ? 'within the hour' : hours < 24 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`
  return `Empty ${whenText(row.emptyAt, row.timeKnown)} (${away})`
}

export function idleText(row: EmptyTruckRow, horizonEnd: number): string {
  if (row.kind === 'BACK_TO_BACK') return 'Next load follows right away'
  if (row.openEnded) return `No load booked: idle ${daysText(row.idleDays)} so far to ${dayText(horizonEnd)}`
  return `Idle ${daysText(row.idleDays)} until the next pickup`
}

/** The short status in a card's corner. */
export function cornerChip(row: EmptyTruckRow, now: number): string {
  if (row.kind === 'BACK_TO_BACK') return 'Booked next'
  if (row.alreadyEmpty) return 'Empty now'
  const soon = row.emptyAt - now <= 24 * 3_600_000
  return `Empty ${soon || !row.timeKnown ? whenText(row.emptyAt, row.timeKnown) : `${weekdayText(row.emptyAt)} ${clockText(row.emptyAt)}`}`
}

/** The empty run to the pickup, in words. */
export function runText(miles: number | null, approx: boolean): string {
  return miles == null ? 'distance unknown' : `${approx ? '≈ ' : ''}${miles} mi empty`
}
