import { useState } from 'react'
import type { CustomerRecord } from '@/types/tms'

function linesToArray(value: string): string[] {
  return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

function arrayToLines(value: string[] | null | undefined): string {
  return (value ?? []).join('\n')
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
  requiredDocsText: string
  defaultDivisionKey: string
  defaultSalesRepId: string
  aliasesText: string
  active: boolean
  apptWorkflow: 'UNSET' | 'NONE' | 'BATORY'
}

const APPT_WORKFLOW_OPTIONS: { value: 'UNSET' | 'NONE' | 'BATORY'; label: string }[] = [
  { value: 'UNSET', label: 'Not set — decided by the customer name (Batory match)' },
  { value: 'NONE', label: 'None — ratecon confirms appointments' },
  { value: 'BATORY', label: 'Batory — E2Open + email proof ladder' },
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
    requiredDocsText: arrayToLines(initial?.requiredDocsForInvoice),
    defaultDivisionKey: initial?.defaultDivisionKey ?? '',
    defaultSalesRepId: initial?.defaultSalesRepId ?? '',
    aliasesText: arrayToLines(initial?.aliases),
    active: initial?.active ?? true,
    apptWorkflow: initial?.apptWorkflow ?? 'UNSET',
  }
}

function validateCustomerForm(v: CustomerFormValue): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!v.name.trim()) errors.name = 'Name is required'
  if (v.paymentTermsDays.trim() && (Number.isNaN(Number(v.paymentTermsDays)) || Number(v.paymentTermsDays) < 0)) {
    errors.paymentTermsDays = 'Enter a whole number of days'
  }
  return errors
}

export function useCustomerForm(initial?: CustomerRecord | null) {
  const [value, setValue] = useState<CustomerFormValue>(() => emptyCustomerForm(initial))

  const set = <K extends keyof CustomerFormValue>(key: K, v: CustomerFormValue[K]) => {
    setValue((p) => ({ ...p, [key]: v }))
  }

  const toRecord = (): CustomerRecord => ({
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
    creditLimitCents: value.creditLimitCents,
    creditHoldFlag: value.creditHoldFlag,
    requiredDocsForInvoice: linesToArray(value.requiredDocsText),
    defaultDivisionKey: value.defaultDivisionKey || null,
    defaultSalesRepId: value.defaultSalesRepId.trim() || null,
    aliases: linesToArray(value.aliasesText),
    active: value.active,
    apptWorkflow: value.apptWorkflow === 'UNSET' ? null : value.apptWorkflow,
  })

  const errors = validateCustomerForm(value)
  return { value, set, toRecord, errors }
}

export { APPT_WORKFLOW_OPTIONS }
