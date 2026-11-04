/** Pure helpers shared by the AH4 sections (kept out of the component files for fast refresh). */
import { LABEL, labelFor, type LabelDef } from '../labels'
import { bookedAddressSnapshot } from '@/features/loads/legFields'
import type { LocationRecord } from '@/types/tms'
import { type FormStop, isLocked, lockReason, type LockKey } from '../model'
import type { FormCtx, SectionKey } from '../sectionProps'

/** The blocking message for one control, matched by its `data-testid`. */
export function issueFor(ctx: FormCtx, section: SectionKey, testId: string): string | undefined {
  return ctx.issues.find((i) => i.section === section && i.fieldKey === testId && i.severity === 'error')?.message
}

/** The attributes every labelled control carries. */
export function ctl(def: LabelDef, testId: string = def.testId) {
  return { 'aria-label': labelFor(def), 'data-testid': testId } as const
}

/** `ctx.busy`, a voided shipment, or the named lock: the control is read-only, with the reason as a tooltip. */
export function disabledState(ctx: FormCtx, key?: LockKey): { disabled: boolean; title?: string } {
  const locked = key ? isLocked(ctx.locked, key) : isLocked(ctx.locked, 'all')
  return {
    disabled: ctx.busy || locked,
    title: locked ? (key ? lockReason(ctx.locked, key) : lockReason(ctx.locked, 'all')) : undefined,
  }
}

/** `(XXX) XXX-XXXX`, built as the person types; paste of `+1…` or a bare 10 digits works. */
export function maskPhone(text: string): string {
  let d = text.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
  d = d.slice(0, 10)
  if (d.length === 0) return ''
  if (d.length < 4) return `(${d}`
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

export const digitsOnly = (text: string): string => text.replace(/\D/g, '')
/** Optional leading minus (temperatures). */
export const signedDigits = (text: string): string => {
  const neg = text.trim().startsWith('-')
  const d = text.replace(/\D/g, '')
  return neg ? `-${d}` : d
}
/** Dollars: digits and one decimal point, two decimals. */
export const dollarText = (text: string): string => {
  const t = text.replace(/[^\d.]/g, '')
  const [whole, ...rest] = t.split('.')
  return rest.length ? `${whole}.${rest.join('').slice(0, 2)}` : whole
}

export type StopKey = keyof typeof LABEL.stop

/** Label + test id of one stop control. Pick Up Name / Ready use the red `LABEL.pickup` defs. */
export function stopDef(prefix: string, key: StopKey, required: boolean): LabelDef {
  if (required && (key === 'name' || key === 'ready')) return { ...LABEL.pickup[key], testId: `f-${prefix}-${key}` }
  return { ...LABEL.stop[key], testId: `f-${prefix}-${key}` }
}

const COUNTRY_ALIASES: Record<string, string> = { USA: 'US', 'UNITED STATES': 'US', CAN: 'CA', CANADA: 'CA', MEX: 'MX', MEXICO: 'MX' }
function normCountry(raw: string | null | undefined): string {
  const up = (raw ?? '').trim().toUpperCase()
  return COUNTRY_ALIASES[up] ?? (['US', 'CA', 'MX'].includes(up) ? up : 'US')
}

/** The stop fields a directory location fills in. */
export function stopPatchFromLocation(loc: LocationRecord): Partial<FormStop> {
  const first = loc.contacts?.find((c) => c.name || c.phone || c.email)
  const snap = bookedAddressSnapshot(loc)
  const hasGeo = snap.lat != null && snap.lng != null
  return {
    name: loc.name,
    locationId: loc.id,
    address1: loc.street ?? '',
    address2: loc.street2 ?? '',
    city: loc.city ?? '',
    state: (loc.state ?? '').toUpperCase(),
    zip: loc.zip ?? '',
    country: normCountry(loc.country),
    contact: loc.apptContactName ?? first?.name ?? '',
    phone: maskPhone(loc.apptContactPhone ?? first?.phone ?? ''),
    email: loc.apptContactEmail ?? first?.email ?? '',
    hours: loc.hours ?? '',
    geo: hasGeo ? { lat: snap.lat, lng: snap.lng, timezone: snap.timezone ?? null, geocodeExpiresAt: snap.geocodeExpiresAt ?? null } : null,
  }
}

