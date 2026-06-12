import { z } from 'zod'
import { differenceInCalendarDays, parseISO, subYears } from 'date-fns'

export const driverSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z
    .string()
    .refine(
      (v) => v.replace(/\D/g, '').length >= 10,
      'Phone must contain at least 10 digits'
    ),
  active: z.boolean(),
  type: z.enum(['driver', 'broker']),
  colorKey: z.enum([
    'driver-1','driver-2','driver-3','driver-4','driver-5','driver-6',
    'driver-7','driver-8','driver-9','driver-10','driver-11','driver-12',
    'broker',
  ]).optional(),
  notes: z.string().optional(),
  // Compliance fields
  email: z.string().optional(),
  cdl: z.string().optional(),
  cdlExpiration: z.string().optional(),
  medCardExpiration: z.string().optional(),
  drugTestDate: z.string().optional(),
  hireDate: z.string().optional(),
  driverType: z.enum(['COMPANY', 'OWNER_OPERATOR']).optional(),
})

const apptTypeEnum = z.enum(['exact', 'range', 'fcfs', 'tbd'])

export const loadSchema = z
  .object({
    aljexId: z.string().min(1, 'Pro # is required'),
    tmsId: z.string().min(1, 'TMS ID / PO is required'),
    pickupNumber: z.string().min(1, 'PU# is required'),

    originName:      z.string().optional(),
    originCity:      z.string().optional(),
    destinationName: z.string().optional(),
    destinationCity: z.string().optional(),

    pickupApptType: apptTypeEnum,
    pickupAppt: z.string().min(1, 'Pickup appointment is required'),
    pickupApptEnd: z.string().optional(),

    deliveryApptType: apptTypeEnum,
    deliveryAppt: z.string(),
    deliveryApptEnd: z.string().optional(),

    pickupDriverId: z.string().nullable(),
    deliveryDriverId: z.string().nullable(),
    readyToInvoice: z.boolean(),

    // Extended fields (optional)
    customer: z.string().optional().nullable(),
    miles: z.number().min(0).optional().nullable(),
    rate: z.number().min(0).optional().nullable(),   // dollars in form, stored as cents
    notes: z.string().optional().nullable(),
    hot: z.boolean().optional(),                      // urgent/"hot" load — 🔥 in schedule
  })
  .refine(
    (d) => d.deliveryApptType === 'fcfs' || d.deliveryAppt.length > 0,
    { message: 'Delivery appointment is required', path: ['deliveryAppt'] }
  )
  .refine(
    (d) => d.pickupApptType === 'tbd' || d.deliveryApptType === 'tbd' || d.pickupApptType === 'fcfs' || d.deliveryApptType === 'fcfs' || d.deliveryAppt >= d.pickupAppt,
    { message: 'Delivery must be on or after pickup', path: ['deliveryAppt'] }
  )
  .refine(
    (d) => d.pickupApptType !== 'range' || (!!d.pickupApptEnd && d.pickupApptEnd > d.pickupAppt),
    { message: 'Range end must be after start', path: ['pickupApptEnd'] }
  )
  .refine(
    (d) => d.deliveryApptType !== 'range' || (!!d.deliveryApptEnd && d.deliveryApptEnd > d.deliveryAppt),
    { message: 'Range end must be after start', path: ['deliveryApptEnd'] }
  )

export type DriverFormValues = z.infer<typeof driverSchema>
export type LoadFormValues = z.infer<typeof loadSchema>

// ── DOT compliance & onboarding ────────────────────────────────────────────────

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const driverTypeEnum = z.enum(['COMPANY', 'OWNER_OPERATOR'])

/** New-driver onboarding kickoff form — email is REQUIRED (it is the invite target). */
export const driverOnboardingKickoffSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('A valid email is required to send the invite'),
  driverType: driverTypeEnum,
})
export type DriverOnboardingKickoffValues = z.infer<typeof driverOnboardingKickoffSchema>

// ── DriverApplication (49 CFR 391.21) — the big shared schema ───────────────────
// Used by the portal form (Phase 3). Drafts are lenient; submission is strict.

export const addressEntrySchema = z.object({
  street: z.string().min(1, 'Street is required'),
  city: z.string().min(1, 'City is required'),
  state: z.string().min(2, 'State is required'),
  zip: z.string().min(3, 'ZIP is required'),
  fromDate: dateString,
  toDate: dateString.optional().nullable(), // null/blank = present
})
export type AddressEntry = z.infer<typeof addressEntrySchema>

export const employmentEntrySchema = z.object({
  employerName: z.string().min(1, 'Employer name is required'),
  address: z.string().min(1, 'Address is required'),
  phone: z.string().min(7, 'Phone is required'),
  fromDate: dateString,
  toDate: dateString.optional().nullable(), // null/blank = present
  position: z.string().min(1, 'Position is required'),
  reasonForLeaving: z.string().optional().default(''),
  subjectToFMCSR: z.boolean(),
  safetySensitive: z.boolean(),
  /** Driver-entered explanation for a gap preceding this job (> 30 days). */
  gapExplanation: z.string().optional(),
})
export type EmploymentEntry = z.infer<typeof employmentEntrySchema>

export const priorLicenseSchema = z.object({
  number: z.string().min(1),
  state: z.string().min(2),
  type: z.string().optional().default(''),
})

export const accidentSchema = z.object({
  date: dateString,
  nature: z.string().min(1, 'Describe the accident'),
  fatalities: z.coerce.number().int().min(0).default(0),
  injuries: z.coerce.number().int().min(0).default(0),
  hazmatSpill: z.boolean().default(false),
})

export const violationSchema = z.object({
  date: dateString,
  offense: z.string().min(1, 'Describe the violation'),
  location: z.string().optional().default(''),
  penalty: z.string().optional().default(''),
})

const ssnLast4 = z.string().regex(/^\d{4}$/, 'Enter the last 4 digits only')

// Lenient base — every field optional so a half-filled draft always saves.
export const driverApplicationDraftSchema = z.object({
  driverId: z.string().min(1),
  // Personal
  legalName: z.string().optional(),
  dob: dateString.optional(),
  ssnLast4: ssnLast4.optional(),
  phone: z.string().optional(),
  currentAddress: z.string().optional(),
  addressHistory: z.array(addressEntrySchema).optional().default([]),
  // License
  cdlNumber: z.string().optional(),
  cdlState: z.string().optional(),
  cdlClass: z.string().optional(),
  endorsements: z.array(z.string()).optional().default([]),
  cdlExpiration: dateString.optional(),
  priorLicenses: z.array(priorLicenseSchema).optional().default([]),
  // Employment
  employmentHistory: z.array(employmentEntrySchema).optional().default([]),
  // Driving record
  accidents: z.array(accidentSchema).optional().default([]),
  violations: z.array(violationSchema).optional().default([]),
  // ELDT
  cdlIssuedAfterFeb2022: z.boolean().optional(),
  eldtProviderName: z.string().optional(),
  // Certification
  signatureName: z.string().optional(),
  attestation: z.boolean().optional(),
})
export type DriverApplicationDraft = z.infer<typeof driverApplicationDraftSchema>

// Strict — enforced on submit. The portal additionally enforces employment coverage.
export const driverApplicationSubmitSchema = driverApplicationDraftSchema
  .extend({
    legalName: z.string().min(1, 'Legal name is required'),
    dob: dateString,
    ssnLast4,
    phone: z.string().min(7, 'Phone is required'),
    currentAddress: z.string().min(1, 'Current address is required'),
    cdlNumber: z.string().min(1, 'CDL number is required'),
    cdlState: z.string().min(2, 'CDL state is required'),
    cdlClass: z.string().min(1, 'CDL class is required'),
    cdlExpiration: dateString,
    employmentHistory: z.array(employmentEntrySchema).min(1, 'Add your employment history'),
    cdlIssuedAfterFeb2022: z.boolean(),
    signatureName: z.string().min(1, 'Type your full legal name to sign'),
    attestation: z.literal(true, {
      message: 'You must attest that the information is true and complete',
    }),
  })
  .refine((d) => !d.cdlIssuedAfterFeb2022 || (d.eldtProviderName?.trim().length ?? 0) > 0, {
    message: 'ELDT provider name is required when your CDL was issued after Feb 7, 2022',
    path: ['eldtProviderName'],
  })
export type DriverApplicationSubmit = z.infer<typeof driverApplicationSubmitSchema>

// ── Employment-gap + address-coverage helpers (shared with the portal) ──────────

export interface DateGap {
  fromDate: string
  toDate: string
  days: number
}

interface Interval {
  from: string
  to: string | null | undefined
}

/** Today as YYYY-MM-DD, or a provided override (keeps helpers pure/testable). */
function todayISO(asOf?: string): string {
  return asOf ?? new Date().toISOString().slice(0, 10)
}

/** Merge overlapping/contiguous intervals, treating null `to` as `asOf`. */
function mergeIntervals(intervals: Interval[], asOf: string): { from: string; to: string }[] {
  const norm = intervals
    .filter((i) => i.from)
    .map((i) => ({ from: i.from, to: i.to && i.to.length ? i.to : asOf }))
    .sort((a, b) => a.from.localeCompare(b.from))

  const merged: { from: string; to: string }[] = []
  for (const cur of norm) {
    const last = merged[merged.length - 1]
    if (last && cur.from <= last.to) {
      if (cur.to > last.to) last.to = cur.to
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

/**
 * Gaps (> `thresholdDays`) within the covered window AND after the most recent job
 * up to `asOf`. Used to prompt the driver to explain time not accounted for.
 */
export function findEmploymentGaps(
  entries: Pick<EmploymentEntry, 'fromDate' | 'toDate'>[],
  opts?: { asOf?: string; thresholdDays?: number },
): DateGap[] {
  const asOf = todayISO(opts?.asOf)
  const threshold = opts?.thresholdDays ?? 30
  const merged = mergeIntervals(
    entries.map((e) => ({ from: e.fromDate, to: e.toDate })),
    asOf,
  )
  if (merged.length === 0) return []

  const gaps: DateGap[] = []
  for (let i = 1; i < merged.length; i++) {
    const prevEnd = merged[i - 1].to
    const nextStart = merged[i].from
    const days = differenceInCalendarDays(parseISO(nextStart), parseISO(prevEnd))
    if (days > threshold) gaps.push({ fromDate: prevEnd, toDate: nextStart, days })
  }
  // Gap between the most recent job end and today
  const lastEnd = merged[merged.length - 1].to
  const tailDays = differenceInCalendarDays(parseISO(asOf), parseISO(lastEnd))
  if (tailDays > threshold) gaps.push({ fromDate: lastEnd, toDate: asOf, days: tailDays })

  return gaps
}

/** Earliest covered start date across all employment entries (YYYY-MM-DD) or null. */
export function earliestEmploymentStart(
  entries: Pick<EmploymentEntry, 'fromDate'>[],
): string | null {
  const starts = entries.map((e) => e.fromDate).filter(Boolean).sort()
  return starts[0] ?? null
}

/**
 * Whether employment history reaches back `requiredYears` (3 normally, 10 for CDL holders).
 * Coverage means the earliest start is at or before (asOf − requiredYears).
 */
export function employmentMeetsCoverage(
  entries: Pick<EmploymentEntry, 'fromDate'>[],
  requiredYears: number,
  asOf?: string,
): boolean {
  const earliest = earliestEmploymentStart(entries)
  if (!earliest) return false
  const cutoff = subYears(parseISO(todayISO(asOf)), requiredYears)
  return parseISO(earliest) <= cutoff
}

/** Address history must reach back 3 years (49 CFR 391.21 residence history). */
export function addressMeetsCoverage(
  entries: Pick<AddressEntry, 'fromDate'>[],
  asOf?: string,
): boolean {
  return employmentMeetsCoverage(entries, 3, asOf)
}

// ── Lightweight form schemas for internal compliance UI ─────────────────────────

export const complianceDocumentInputSchema = z.object({
  entityType: z.enum(['DRIVER', 'TRUCK']),
  entityId: z.string().min(1),
  documentType: z.string().min(1),
  title: z.string().min(1, 'Title is required'),
  s3Key: z.string().optional(),
  issueDate: dateString.optional(),
  expirationDate: dateString.optional(),
  notes: z.string().optional(),
})
export type ComplianceDocumentInput = z.infer<typeof complianceDocumentInputSchema>

export const rejectionReasonSchema = z.object({
  rejectionReason: z
    .string()
    .min(3, 'A reason is required — it is shown to the driver in their portal'),
})

export const escalationRuleSchema = z.object({
  documentType: z.string().min(1),
  daysBeforeExpiration: z.coerce.number().int().min(0),
  recipients: z.enum(['DRIVER', 'MANAGER', 'BOTH']),
  templateKey: z.string().min(1),
  active: z.boolean(),
})
export type EscalationRuleValues = z.infer<typeof escalationRuleSchema>
