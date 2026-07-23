// Pure helpers for compliance status derivation + display.
// Shared by the internal UI and mirrored by the compliance-scanner Lambda.
import type {
  AlertSeverity,
  ComplianceDocumentStatus,
  ComplianceStatus,
  DriverOnboardingStatus,
  OnboardingTaskStatus,
} from '@/types'
import type { DefaultExpirationRule } from '@/lib/complianceRequirements'

export const EXPIRING_SOON_DAYS = 30

/** Whole days from today until `dateStr` (YYYY-MM-DD). Negative = past. null if no date. */
export function daysUntil(dateStr?: string | null, asOf?: string): number | null {
  if (!dateStr) return null
  const today = asOf ? new Date(`${asOf}T00:00:00Z`) : new Date()
  const target = new Date(`${dateStr}T00:00:00Z`)
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const diffMs = target.getTime() - startOfToday
  return Math.round(diffMs / 86_400_000)
}

/** Document status driven purely by its expiration date (VALID/EXPIRING_SOON/EXPIRED). */
export function expirationStatus(
  expirationDate?: string | null,
  asOf?: string,
): 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' {
  const d = daysUntil(expirationDate, asOf)
  if (d === null) return 'VALID' // non-expiring
  if (d < 0) return 'EXPIRED'
  if (d <= EXPIRING_SOON_DAYS) return 'EXPIRING_SOON'
  return 'VALID'
}

/** Alert severity from days-remaining. null when > 60 days out (no alert needed). */
export function severityFromDays(days: number): AlertSeverity | null {
  if (days < 0) return 'EXPIRED'
  if (days <= 7) return 'CRITICAL'
  if (days <= 30) return 'URGENT'
  if (days <= 60) return 'UPCOMING'
  return null
}

// ── Display maps ────────────────────────────────────────────────────────────────

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'green' | 'orange'

export function documentStatusBadge(status: ComplianceDocumentStatus): { variant: BadgeVariant; label: string } {
  switch (status) {
    case 'VALID': return { variant: 'green', label: 'Valid' }
    case 'EXPIRING_SOON': return { variant: 'orange', label: 'Expiring soon' }
    case 'EXPIRED': return { variant: 'destructive', label: 'Expired' }
    case 'PENDING_REVIEW': return { variant: 'default', label: 'Pending review' }
    case 'REJECTED': return { variant: 'destructive', label: 'Rejected' }
    case 'MISSING': return { variant: 'destructive', label: 'Missing' }
    case 'WAIVED': return { variant: 'secondary', label: 'Waived' }
    default: return { variant: 'secondary', label: status }
  }
}

export function taskStatusBadge(status: OnboardingTaskStatus): { variant: BadgeVariant; label: string } {
  switch (status) {
    case 'COMPLETE': return { variant: 'green', label: 'Complete' }
    case 'WAIVED': return { variant: 'secondary', label: 'Waived' }
    case 'NOT_APPLICABLE': return { variant: 'secondary', label: 'N/A' }
    case 'PENDING_REVIEW': return { variant: 'default', label: 'Pending review' }
    case 'AWAITING_DRIVER': return { variant: 'orange', label: 'Awaiting driver' }
    case 'PENDING': return { variant: 'outline', label: 'To do' }
    default: return { variant: 'secondary', label: status }
  }
}

export function severityBadge(severity: AlertSeverity): { variant: BadgeVariant; label: string } {
  switch (severity) {
    case 'EXPIRED': return { variant: 'destructive', label: 'Expired' }
    case 'CRITICAL': return { variant: 'destructive', label: 'Critical' }
    case 'URGENT': return { variant: 'orange', label: 'Urgent' }
    case 'UPCOMING': return { variant: 'default', label: 'Upcoming' }
    default: return { variant: 'secondary', label: severity }
  }
}

export function complianceStatusBadge(status?: ComplianceStatus | null): { variant: BadgeVariant; label: string } {
  switch (status) {
    case 'COMPLIANT': return { variant: 'green', label: 'Compliant' }
    case 'EXPIRING_SOON': return { variant: 'orange', label: 'Expiring soon' }
    case 'NON_COMPLIANT': return { variant: 'destructive', label: 'Non-compliant' }
    default: return { variant: 'secondary', label: 'Unknown' }
  }
}

export function onboardingStatusLabel(status?: DriverOnboardingStatus | null): string {
  switch (status) {
    case 'NOT_STARTED': return 'Not started'
    case 'INVITED': return 'Invited'
    case 'IN_PROGRESS': return 'In progress'
    case 'PENDING_REVIEW': return 'Pending review'
    case 'COMPLETE': return 'Complete'
    case 'ARCHIVED': return 'Archived'
    default: return 'Not started'
  }
}

// ── Smart expiration defaults for the truck wizard ──────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Compute a default expiration date for a requirement given its rule.
 *  - DEC_31 / AUG_31: fixed annual date in the current (or next, if already past) year
 *  - PLUS_N_MONTHS: issue/inspection date (or today) + months
 */
export function smartDefaultExpiration(
  rule: DefaultExpirationRule | undefined,
  months: number | undefined,
  issueDate?: string,
  asOf?: string,
): string | undefined {
  const today = asOf ? new Date(`${asOf}T00:00:00Z`) : new Date()
  if (rule === 'DEC_31' || rule === 'AUG_31') {
    const month = rule === 'DEC_31' ? 11 : 7 // 0-indexed: Dec=11, Aug=7
    const day = rule === 'DEC_31' ? 31 : 31
    let year = today.getUTCFullYear()
    const candidate = new Date(Date.UTC(year, month, day))
    if (candidate.getTime() < today.getTime()) year += 1
    return isoDate(new Date(Date.UTC(year, month, day)))
  }
  if (rule === 'PLUS_N_MONTHS' && months) {
    const base = issueDate ? new Date(`${issueDate}T00:00:00Z`) : today
    const d = new Date(base)
    d.setUTCMonth(d.getUTCMonth() + months)
    return isoDate(d)
  }
  return undefined
}
