import { daysUntil } from './complianceStatus'

/** "in 12 days" / "5 days ago" / "today". null date → em-dash. */
export function daysRemainingLabel(date?: string | null): string {
  const d = daysUntil(date)
  if (d === null) return '—'
  if (d === 0) return 'today'
  if (d > 0) return `in ${d} day${d === 1 ? '' : 's'}`
  return `${Math.abs(d)} day${d === -1 ? '' : 's'} ago`
}
