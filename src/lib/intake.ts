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
  NEW:         { label: 'New',         className: 'bg-sky-50 text-sky-700 border-sky-200' },
  IN_PROGRESS: { label: 'In Progress', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  BUILT:       { label: 'Built',       className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  DONE:        { label: 'Done',        className: 'bg-slate-100 text-slate-600 border-slate-200' },
  ARCHIVED:    { label: 'Archived',    className: 'bg-slate-50 text-slate-400 border-slate-200' },
}

export const SOURCE_LABEL: Record<string, string> = {
  IVAN_CARTAGE:   'Ivan Cartage',
  BCAT_LOGISTICS: 'BCAT Logistics',
}

export const ACTIVE_STATUSES = new Set<IntakeStatus>(['NEW', 'IN_PROGRESS'])
