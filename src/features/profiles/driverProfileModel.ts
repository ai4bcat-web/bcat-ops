/**
 * The pure side of the Driver profile: what the list shows, what the pay tab summarises and
 * what the new-driver wizard starts from. Nothing here reads a store or calls an API; every
 * number comes from records the rest of the app already keeps (Driver, DriverPaySetting, the
 * compliance documents), so the profile and the old pages can never disagree.
 */
import type { Driver } from '@/types'
import type { DriverFleet } from '@/types/equipment'
import type { DriverPaySetting } from '@/lib/apiClient'
import { classificationForFleet, readyScore, slotState, slotsForDriver, visibleSlots, type ReadyScore, type SlotState } from '@/lib/fileHub'

/** The same formatting the driver editor applies on save, so a number looks identical everywhere. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^1/, '')
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  return raw
}

/** The types a new driver can be. Amazon drivers are owner operators (Ryne 2026-11-11), so it is not offered. */
export const FLEET_OPTIONS: Array<{ value: DriverFleet; label: string }> = [
  { value: 'LOCAL', label: 'Local driver' },
  { value: 'OWNER_OPERATOR', label: 'Owner operator' },
  { value: 'BOX_TRUCK', label: 'Box truck' },
]

/** An existing Amazon driver reads as an owner operator; the stored fleet group is not rewritten. */
export function fleetLabel(fleet: string | null | undefined): string {
  if (!fleet) return 'Unassigned'
  const shown = fleet === 'AMAZON' ? 'OWNER_OPERATOR' : fleet
  return FLEET_OPTIONS.find((o) => o.value === shown)?.label ?? fleet
}

/** Where a fleet's weekly/biweekly settlement lives today, for the "open settlements" links. */
export function settlementLink(fleet: string | null | undefined): { to: string; label: string } | null {
  switch (fleet) {
    case 'BOX_TRUCK': return { to: '/driver-pay-box-trucks', label: 'Box truck settlements' }
    case 'AMAZON': return { to: '/driver-pay', label: 'Amazon settlements' }
    case 'OWNER_OPERATOR': return { to: '/owner-operator-pay', label: 'Owner operator settlements' }
    case 'LOCAL': return { to: '/hours', label: 'Employee hours' }
    default: return null
  }
}

export interface DocsSummary extends ReadyScore {
  /** One word for the list: Complete, Missing 2, Expiring 1... */
  label: string
  tone: 'green' | 'orange' | 'red' | 'gray'
}

/** A driver's document status, from the same slots and rules the Files hub uses. */
export function docsSummary(
  fleet: DriverFleet | null | undefined,
  stateOf: (slotKey: string) => SlotState,
  canSeePrivate: boolean,
): DocsSummary {
  const score = readyScore(visibleSlots(slotsForDriver(fleet), canSeePrivate), stateOf)
  if (score.required === 0) return { ...score, label: 'None required', tone: 'gray' }
  if (score.missing > 0) return { ...score, label: `Missing ${score.missing}`, tone: 'red' }
  if (score.attention > 0) return { ...score, label: `Expiring ${score.attention}`, tone: 'orange' }
  return { ...score, label: 'Complete', tone: 'green' }
}

/** Plain-state resolver for a driver's slots from the documents on file. */
export const driverSlotState = (doc: Parameters<typeof slotState>[0]): SlotState => slotState(doc)

export interface PayLine { label: string; value: string }

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

/** The pay tab's read-out of a driver's stored setting. Empty when no setting exists yet. */
export function payLines(setting: DriverPaySetting | undefined, fleet: string | null | undefined): PayLine[] {
  if (fleet === 'LOCAL' && !setting) return [{ label: 'Pay model', value: 'Hourly (time card)' }]
  if (!setting) return []
  const lines: PayLine[] = [
    { label: 'Pay group', value: fleetLabel(setting.payGroup ?? fleet) },
    { label: 'Pay percent', value: `${Math.round(setting.payPercent * 1000) / 10}%` },
    { label: 'Calculation', value: setting.expensesBeforePercent ? '% of net, after expenses' : '% of gross, then minus expenses' },
    { label: 'Fuel card (EFS)', value: setting.fuelCardNumber?.trim() || '' },
    { label: 'Settlement e-mail', value: setting.email?.trim() || '' },
  ]
  if (setting.hourlyRate != null) lines.push({ label: 'Hourly rate', value: `${money(setting.hourlyRate)}/hr` })
  return lines
}

/** The fixed weekly charges that are in force today: [{label, amount}]. */
export function currentFixedExpenses(setting: DriverPaySetting | undefined, today: string): Array<{ label: string; amount: number }> {
  const list = (setting?.fixedExpenses ?? []) as Array<{ label?: string; amount?: number; from?: string; until?: string | null; endedAt?: string | null }>
  return list
    .filter((e) => !e.endedAt && (!e.from || e.from <= today) && (!e.until || e.until > today))
    .map((e) => ({ label: e.label ?? 'Expense', amount: Number(e.amount ?? 0) }))
}

// ── New-driver wizard ──────────────────────────────────────────────────────────

export interface WizardPayDefaults {
  /** True when this fleet is paid on a percentage; Local drivers are hourly and get no pay setting here. */
  percentPaid: boolean
  percent: string
  /** The Chad model: % applied after expenses. Box trucks and owner operators default to it, as their settings modals do. */
  afterExpenses: boolean
}

export function wizardPayDefaults(fleet: DriverFleet | null | undefined): WizardPayDefaults {
  switch (fleet) {
    case 'BOX_TRUCK': return { percentPaid: true, percent: '50', afterExpenses: true }
    case 'OWNER_OPERATOR': return { percentPaid: true, percent: '50', afterExpenses: true }
    case 'AMAZON': return { percentPaid: true, percent: '', afterExpenses: false }
    default: return { percentPaid: false, percent: '', afterExpenses: false }
  }
}

export interface BasicsInput {
  name: string; phone: string; email: string; fleet: DriverFleet | ''
  /** Optional. Dates are yyyy-mm-dd (a date input). */
  cdl?: string; cdlExpiration?: string; hireDate?: string; medCardExpiration?: string
}

/** What blocks "Next" on the Basics step: a field → message map, empty when fine. */
export function basicsErrors(b: BasicsInput): Partial<Record<keyof BasicsInput, string>> {
  const errors: Partial<Record<keyof BasicsInput, string>> = {}
  if (!b.name.trim()) errors.name = 'Enter the driver’s name.'
  if (b.phone.replace(/\D/g, '').length < 10) errors.phone = 'Phone needs at least 10 digits.'
  if (b.email.trim() && !/^\S+@\S+\.\S+$/.test(b.email.trim())) errors.email = 'That e-mail does not look right.'
  if (!b.fleet) errors.fleet = 'Choose the driver type.'
  for (const key of ['cdlExpiration', 'hireDate', 'medCardExpiration'] as const) {
    const v = (b[key] ?? '').trim()
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[key] = 'Pick a date.'
  }
  return errors
}

/** A Local driver's starting hourly rate: blank is allowed (set it later on Employee hours), otherwise above $0. */
export function hourlyRateError(rate: string): string | null {
  if (!rate.trim()) return null
  const n = parseFloat(rate.replace(/[$,\s]/g, ''))
  return isFinite(n) && n > 0 ? null : 'Enter a rate above $0 an hour.'
}

/** Pay step is valid when the fleet is hourly, or the percent is 1-100. */
export function payError(fleet: DriverFleet | '', percent: string): string | null {
  if (!fleet || !wizardPayDefaults(fleet).percentPaid) return null
  const p = parseFloat(percent.replace(/[%\s]/g, ''))
  if (!isFinite(p) || p <= 0 || p > 100) return 'Enter a pay percent between 1 and 100.'
  return null
}

/** The slots a driver of this fleet must have on file, for the wizard's checklist. */
export function requiredDocsFor(fleet: DriverFleet | null | undefined, canSeePrivate: boolean) {
  return visibleSlots(slotsForDriver(fleet), canSeePrivate).filter((s) => s.required)
}

export { classificationForFleet }
export type { Driver }
