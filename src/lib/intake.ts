import type { IntakeStatus } from '@/types'

export const TEAM_MEMBERS = [
  { email: 'dennis@bcatcorp.com', name: 'Dennis' },
  { email: 'arcie@bcatcorp.com',  name: 'Arcie'  },
  { email: 'ryne@bcatcorp.com',   name: 'Ryne'   },
  { email: 'jenny@bcatcorp.com',  name: 'Jenny'  },
  { email: 'ruben@bcatcorp.com',  name: 'Ruben'  },
] as const

export function assigneeLabel(email: string) {
  return TEAM_MEMBERS.find((m) => m.email === email)?.name ?? email.split('@')[0]
}

export const STATUS_BADGE: Record<IntakeStatus, { label: string; className: string }> = {
  NEW:         { label: 'New',         className: 'bg-[color:var(--tms-badge-blue-tint)] text-[color:var(--tms-badge-blue)] border-[color:var(--tms-badge-blue)]' },
  IN_PROGRESS: { label: 'In Progress', className: 'bg-[color:var(--tms-badge-orange-tint)] text-[color:var(--tms-badge-orange)] border-[color:var(--tms-badge-orange)]' },
  BUILT:       { label: 'Built',       className: 'bg-[color:var(--tms-badge-green-tint)] text-[color:var(--tms-badge-green)] border-[color:var(--tms-badge-green)]' },
  DONE:        { label: 'Done',        className: 'bg-muted text-muted-foreground border-border' },
  ARCHIVED:    { label: 'Archived',    className: 'bg-muted text-muted-foreground border-border' },
}

export const SOURCE_LABEL: Record<string, string> = {
  IVAN_CARTAGE:   'Ivan Cartage',
  BCAT_LOGISTICS: 'BCAT Logistics',
}

export const ACTIVE_STATUSES = new Set<IntakeStatus>(['NEW', 'IN_PROGRESS'])
