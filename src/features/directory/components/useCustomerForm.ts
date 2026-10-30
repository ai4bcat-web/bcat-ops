import { useState, useMemo } from 'react'
import type {
  CustomerRecord,
  CustomerContact,
  BillToParty,
  RequiredReference,
  ChargeCodeOverride,
  DefaultCharge,
  PricingDefaults,
  QuotingDefaults,
  InvoiceFrequency,
  VisibilityPrefs,
  CustomerStatus,
  CheckCallPlan,
} from '@/types/tms'

function linesToArray(value: string): string[] {
  return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

function arrayToLines(value: string[] | null | undefined): string {
  return (value ?? []).join('\n')
}

function emptyVisibilityPrefs(initial?: VisibilityPrefs | null): VisibilityPrefs {
  return {
    milestoneEmails: initial?.milestoneEmails ?? false,
    sharedTrackingLink: initial?.sharedTrackingLink ?? false,
    shipperPortal: initial?.shipperPortal ?? false,
  }
}

function emptyPricingDefaults(initial?: PricingDefaults | null): PricingDefaults {
  return {
    mode: initial?.mode ?? 'MARGIN',
    defaultBps: initial?.defaultBps ?? null,
    defaultProfitCents: initial?.defaultProfitCents ?? null,
    minProfitCents: initial?.minProfitCents ?? null,
    maxProfitCents: initial?.maxProfitCents ?? null,
    singleChargeCode: initial?.singleChargeCode ?? null,
    distribution: initial?.distribution ?? null,
  }
}

function emptyQuotingDefaults(initial?: QuotingDefaults | null): QuotingDefaults {
  return {
    defaultMode: initial?.defaultMode ?? null,
    hoursToQuote: initial?.hoursToQuote ?? null,
    notes: initial?.notes ?? null,
    portalLtlDispatchMode: initial?.portalLtlDispatchMode ?? null,
    portalStatusMask: initial?.portalStatusMask ?? [],
    blockedLtlCarrierIds: initial?.blockedLtlCarrierIds ?? [],
    selfQuoteCarrierIds: initial?.selfQuoteCarrierIds ?? [],
  }
}

export interface CustomerFormValue {
  name: string
  contactName: string
  contactEmail: string
  contactPhone: string
  notes: string
  mcNumber: string
  dotNumber: string
  billingContactName: string
  billingEmail: string
  billingPhone: string
  billingAddressStreet: string
  billingAddressCity: string
  billingAddressState: string
  billingAddressZip: string
  billingAddressCountry: string
  paymentTermsDays: string
  creditLimitCents: number | null
  creditHoldFlag: boolean
  /** Stored strings, typed values plus anything that predates the vocabulary. */
  requiredDocs: string[]
  defaultDivisionKey: string
  defaultSalesRepId: string
  aliasesText: string
  active: boolean
  apptWorkflow: 'UNSET' | 'NONE' | 'BATORY'

  status: CustomerStatus | ''
  leadSource: string
  industry: string
  serviceTier: string
  website: string
  freeCreditRequired: boolean | null
  creditUsageWarningBps: number | null
  maxDaysLate: number | null
  invoiceFrequency: InvoiceFrequency | ''
  visibilityPrefs: VisibilityPrefs
  gpSplitBps: number | null
  rateConTerms: string
  teamKey: string
  operatedById: string
  accountOwnerIdsText: string
  /** The ids this customer carries in another system; stored for the integration that uses them. */
  project44CustomerId: string
  hubspotId: string

  contacts: CustomerContact[]
  billToParties: BillToParty[]
  requiredReferences: RequiredReference[]
  chargeCodeOverrides: ChargeCodeOverride[]
  defaultCharges: DefaultCharge[]
  pricingDefaults: PricingDefaults
  quotingDefaults: QuotingDefaults

  // Step P3 — flow defaults overriding TmsSettings.
  defaultCarrierTeamKey: string
  defaultCarrierRepId: string
  marginTargetBps: number | null
  marginFloorBps: number | null
  quoteAutoReply: boolean | null
  requiredLoadFields: string[]
  checkCallPlan: CheckCallPlan | null
}

const APPT_WORKFLOW_OPTIONS: { value: 'UNSET' | 'NONE' | 'BATORY'; label: string }[] = [
  { value: 'UNSET', label: 'Not set — decided by the customer name (Batory match)' },
  { value: 'NONE', label: 'None — ratecon confirms appointments' },
  { value: 'BATORY', label: 'Batory — E2Open + email proof ladder' },
]

const INVOICE_FREQUENCY_OPTIONS: { value: InvoiceFrequency; label: string }[] = [
  { value: 'DAILY', label: 'Daily' },
  { value: 'TWICE_WEEKLY', label: 'Twice weekly' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
]

function emptyCustomerForm(initial?: CustomerRecord | null): CustomerFormValue {
  return {
    name: initial?.name ?? '',
    contactName: initial?.contactName ?? '',
    contactEmail: initial?.contactEmail ?? '',
    contactPhone: initial?.contactPhone ?? '',
    notes: initial?.notes ?? '',
    mcNumber: initial?.mcNumber ?? '',
    dotNumber: initial?.dotNumber ?? '',
    billingContactName: initial?.billingContactName ?? '',
    billingEmail: initial?.billingEmail ?? '',
    billingPhone: initial?.billingPhone ?? '',
    billingAddressStreet: initial?.billingAddress?.street ?? '',
    billingAddressCity: initial?.billingAddress?.city ?? '',
    billingAddressState: initial?.billingAddress?.state ?? '',
    billingAddressZip: initial?.billingAddress?.zip ?? '',
    billingAddressCountry: initial?.billingAddress?.country ?? '',
    paymentTermsDays: initial?.paymentTermsDays != null ? String(initial.paymentTermsDays) : '',
    creditLimitCents: initial?.creditLimitCents ?? null,
    creditHoldFlag: initial?.creditHoldFlag ?? false,
    requiredDocs: initial?.requiredDocsForInvoice ?? [],
    defaultDivisionKey: initial?.defaultDivisionKey ?? '',
    defaultSalesRepId: initial?.defaultSalesRepId ?? '',
    aliasesText: arrayToLines(initial?.aliases),
    active: initial?.active ?? true,
    apptWorkflow: initial?.apptWorkflow ?? 'UNSET',

    status: initial?.status ?? '',
    leadSource: initial?.leadSource ?? '',
    industry: initial?.industry ?? '',
    serviceTier: initial?.serviceTier ?? '',
    website: initial?.website ?? '',
    freeCreditRequired: initial?.freeCreditRequired ?? null,
    creditUsageWarningBps: initial?.creditUsageWarningBps ?? null,
    maxDaysLate: initial?.maxDaysLate ?? null,
    invoiceFrequency: initial?.invoiceFrequency ?? '',
    visibilityPrefs: emptyVisibilityPrefs(initial?.visibilityPrefs),
    gpSplitBps: initial?.gpSplitBps ?? null,
    rateConTerms: initial?.rateConTerms ?? '',
    teamKey: initial?.teamKey ?? '',
    operatedById: initial?.operatedById ?? '',
    accountOwnerIdsText: arrayToLines(initial?.accountOwnerIds),
    project44CustomerId: initial?.project44CustomerId ?? '',
    hubspotId: initial?.hubspotId ?? '',

    contacts: initial?.contacts ?? [],
    billToParties: initial?.billToParties ?? [],
    requiredReferences: initial?.requiredReferences ?? [],
    chargeCodeOverrides: initial?.chargeCodeOverrides ?? [],
    defaultCharges: initial?.defaultCharges ?? [],
    pricingDefaults: emptyPricingDefaults(initial?.pricingDefaults),
    quotingDefaults: emptyQuotingDefaults(initial?.quotingDefaults),

    defaultCarrierTeamKey: initial?.defaultCarrierTeamKey ?? '',
    defaultCarrierRepId: initial?.defaultCarrierRepId ?? '',
    marginTargetBps: initial?.marginTargetBps ?? null,
    marginFloorBps: initial?.marginFloorBps ?? null,
    quoteAutoReply: initial?.quoteAutoReply ?? null,
    requiredLoadFields: initial?.requiredLoadFields ?? [],
    checkCallPlan: initial?.checkCallPlan ?? null,
  }
}

function parseOptionalCents(raw: number | null): number | null {
  if (raw == null) return null
  return Math.round(raw)
}

function parseOptionalBps(raw: number | null): number | null {
  if (raw == null) return null
  const n = Math.round(raw)
  if (n < 0 || n > 10000) return null
  return n
}

function validateCustomerForm(v: CustomerFormValue): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!v.name.trim()) errors.name = 'Name is required'
  if (v.paymentTermsDays.trim() && (Number.isNaN(Number(v.paymentTermsDays)) || Number(v.paymentTermsDays) < 0)) {
    errors.paymentTermsDays = 'Enter a whole number of days'
  }
  const warnBps = v.creditUsageWarningBps
  if (warnBps != null && (warnBps < 0 || warnBps > 10000)) {
    errors.creditUsageWarningBps = 'Enter 0–10000 basis points'
  }
  const maxDaysLate = v.maxDaysLate
  if (maxDaysLate != null && (maxDaysLate < 0 || !Number.isInteger(maxDaysLate))) {
    errors.maxDaysLate = 'Enter a whole number of days'
  }
  const gpSplit = v.gpSplitBps
  if (gpSplit != null && (gpSplit < 0 || gpSplit > 10000)) {
    errors.gpSplitBps = 'Enter 0–10000 basis points'
  }
  const pricing = v.pricingDefaults
  if (pricing.defaultBps != null && (pricing.defaultBps < 0 || pricing.defaultBps > 10000)) {
    errors.pricingDefaultsDefaultBps = 'Enter 0–10000 basis points'
  }
  if (pricing.minProfitCents != null && pricing.maxProfitCents != null && pricing.minProfitCents > pricing.maxProfitCents) {
    errors.pricingDefaultsProfitRange = 'Min profit must be ≤ max profit'
  }

  const targetBps = v.marginTargetBps
  if (targetBps != null && (targetBps < 0 || targetBps > 9999)) {
    errors.marginTargetBps = 'Enter 0–9999 basis points'
  }
  const floorBps = v.marginFloorBps
  if (floorBps != null && (floorBps < 0 || floorBps > 9999)) {
    errors.marginFloorBps = 'Enter 0–9999 basis points'
  }
  if (targetBps != null && floorBps != null && floorBps > targetBps) {
    errors.marginFloorBps = 'Floor cannot be above the target margin'
  }
  return errors
}

export function useCustomerForm(initial?: CustomerRecord | null) {
  const [value, setValue] = useState<CustomerFormValue>(() => emptyCustomerForm(initial))

  const set = <K extends keyof CustomerFormValue>(key: K, v: CustomerFormValue[K]) => {
    setValue((p) => ({ ...p, [key]: v }))
  }

  const setPartial = (patch: Partial<CustomerFormValue>) => {
    setValue((p) => ({ ...p, ...patch }))
  }

  const toRecord = (opts: { includeStatus?: boolean } = {}): CustomerRecord => ({
    id: initial?.id ?? '',
    createdAt: initial?.createdAt ?? new Date().toISOString(),
    updatedAt: initial?.updatedAt ?? new Date().toISOString(),
    name: value.name.trim(),
    contactName: value.contactName.trim() || null,
    contactEmail: value.contactEmail.trim() || null,
    contactPhone: value.contactPhone.trim() || null,
    notes: value.notes.trim() || null,
    mcNumber: value.mcNumber.trim() || null,
    dotNumber: value.dotNumber.trim() || null,
    billingContactName: value.billingContactName.trim() || null,
    billingEmail: value.billingEmail.trim() || null,
    billingPhone: value.billingPhone.trim() || null,
    billingAddress: {
      street: value.billingAddressStreet.trim() || null,
      city: value.billingAddressCity.trim() || null,
      state: value.billingAddressState.trim() || null,
      zip: value.billingAddressZip.trim() || null,
      country: value.billingAddressCountry.trim() || null,
    },
    paymentTermsDays: value.paymentTermsDays.trim() ? Number(value.paymentTermsDays) : null,
    creditLimitCents: parseOptionalCents(value.creditLimitCents),
    creditHoldFlag: value.creditHoldFlag,
    requiredDocsForInvoice: value.requiredDocs,
    defaultDivisionKey: value.defaultDivisionKey || null,
    defaultSalesRepId: value.defaultSalesRepId.trim() || null,
    aliases: linesToArray(value.aliasesText),
    active: value.active,
    apptWorkflow: value.apptWorkflow === 'UNSET' ? null : value.apptWorkflow,

    status: opts.includeStatus !== false ? (value.status || null) : (initial?.status ?? null),
    leadSource: value.leadSource.trim() || null,
    industry: value.industry.trim() || null,
    serviceTier: value.serviceTier.trim() || null,
    website: value.website.trim() || null,
    freeCreditRequired: value.freeCreditRequired,
    creditUsageWarningBps: parseOptionalBps(value.creditUsageWarningBps),
    maxDaysLate: value.maxDaysLate,
    invoiceFrequency: value.invoiceFrequency || null,
    visibilityPrefs: value.visibilityPrefs,
    gpSplitBps: parseOptionalBps(value.gpSplitBps),
    rateConTerms: value.rateConTerms.trim() || null,
    teamKey: value.teamKey.trim() || null,
    operatedById: value.operatedById.trim() || null,
    accountOwnerIds: linesToArray(value.accountOwnerIdsText),
    project44CustomerId: value.project44CustomerId.trim() || null,
    hubspotId: value.hubspotId.trim() || null,

    contacts: value.contacts.length ? value.contacts : null,
    billToParties: value.billToParties.length ? value.billToParties : null,
    requiredReferences: value.requiredReferences.length ? value.requiredReferences : null,
    chargeCodeOverrides: value.chargeCodeOverrides.length ? value.chargeCodeOverrides : null,
    defaultCharges: value.defaultCharges.length ? value.defaultCharges : null,
    pricingDefaults: value.pricingDefaults,
    quotingDefaults: value.quotingDefaults,

    defaultCarrierTeamKey: value.defaultCarrierTeamKey.trim() || null,
    defaultCarrierRepId: value.defaultCarrierRepId.trim() || null,
    marginTargetBps: parseOptionalBps(value.marginTargetBps),
    marginFloorBps: parseOptionalBps(value.marginFloorBps),
    quoteAutoReply: value.quoteAutoReply,
    requiredLoadFields: value.requiredLoadFields.length ? value.requiredLoadFields : null,
    checkCallPlan: value.checkCallPlan,
  })

  const errors = useMemo(() => validateCustomerForm(value), [value])
  return { value, set, setPartial, toRecord, errors }
}

export { APPT_WORKFLOW_OPTIONS, INVOICE_FREQUENCY_OPTIONS }
