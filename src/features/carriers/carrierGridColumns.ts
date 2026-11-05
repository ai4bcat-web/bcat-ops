/**
 * The Carriers board's columns on the shared dense grid: what each cell says, how it sorts and
 * which header filter it offers. Pure; the page only renders chips on top of the plain text.
 * Every value comes off the carrier record the directory already holds, so nothing here reads
 * the network.
 */
import type { DenseColumn, DenseOption } from '@/features/tms/grid/denseGridModel'
import { CARRIER_STATUSES, CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import { PACKET_LABELS } from '@/lib/integrations/mcpReview'
import type { McpCarrierStatus } from '@/lib/integrations/mcpAdapter'
import { normalizeMcpStatus } from '@/lib/mcpPacket'
import type { CarrierRecord, InsurancePolicyType } from '@/types/tms'
import type { CarrierRow } from './carrierViews'

/** Visible out of the box; the rest wait in the Columns dialog. */
export const CARRIER_DEFAULT_COLUMNS = [
  'name', 'mcNumber', 'dotNumber', 'status', 'packet', 'riskScore', 'cargoExpiry', 'liabilityExpiry',
  'authority', 'equipment', 'terms', 'factor', 'lastLoadAt', 'loadCount', 'email', 'phone', 'cityState',
]

const lower = (s: string) => s.replace(/_/g, ' ').toLowerCase()

export function packetText(row: CarrierRecord): string {
  const key = normalizeMcpStatus(row.mcpReviewStatus ?? row.mcpStatus)
  return key ? (PACKET_LABELS[key as McpCarrierStatus] ?? key) : 'No packet'
}

/** The latest end date among a carrier's policies of one type (a renewed certificate wins). */
export function policyExpiry(row: CarrierRecord, type: InsurancePolicyType): string | null {
  let best: string | null = null
  for (const p of row.insurancePolicies ?? []) {
    if (p.type === type && p.expiresAt && (best === null || p.expiresAt > best)) best = p.expiresAt
  }
  return best
}

function addressPart(row: CarrierRecord, key: string): string {
  const value = (row.address as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' ? value : ''
}

function cityState(row: CarrierRecord): string {
  return [addressPart(row, 'city'), addressPart(row, 'state')].filter(Boolean).join(', ')
}

function dateText(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : ''
}

const single = (value: string | null | undefined, label: string = value ?? ''): DenseOption[] =>
  value ? [{ value, label }] : []

export function carrierGridColumns(now: string): DenseColumn<CarrierRow>[] {
  const status = (r: CarrierRow) => effectiveCarrierStatus(r, now).status
  return [
    { key: 'name', header: 'Carrier', group: 'Carrier', text: (r) => r.name, sortValue: (r) => r.name.toLowerCase() },
    { key: 'dba', header: 'DBA', group: 'Carrier', text: (r) => r.dbaName ?? '' },
    { key: 'type', header: 'Type', group: 'Carrier', text: (r) => r.type, filter: 'multi', optionsOf: (r) => single(r.type) },
    { key: 'mcNumber', header: 'MC #', group: 'Carrier', text: (r) => r.mcNumber ?? '' },
    { key: 'dotNumber', header: 'DOT #', group: 'Carrier', text: (r) => r.dotNumber ?? '' },
    { key: 'scac', header: 'SCAC', group: 'Carrier', text: (r) => r.scac ?? '' },
    {
      key: 'status',
      header: 'Status',
      group: 'Compliance',
      text: (r) => CARRIER_STATUS_LABELS[status(r)],
      filter: 'multi',
      optionsOf: (r) => single(status(r), CARRIER_STATUS_LABELS[status(r)]),
      fixedOptions: CARRIER_STATUSES.map((s) => ({ value: s, label: CARRIER_STATUS_LABELS[s] })),
    },
    {
      key: 'packet',
      header: 'Packet',
      group: 'Compliance',
      text: packetText,
      filter: 'multi',
      optionsOf: (r) => single(packetText(r)),
    },
    {
      key: 'riskScore',
      header: 'Risk',
      group: 'Compliance',
      text: (r) => (r.mcpRiskScore == null ? '' : String(r.mcpRiskScore)),
      filter: 'number',
      numberOf: (r) => r.mcpRiskScore ?? null,
      numberUnit: 'points',
      align: 'right',
    },
    { key: 'cargoExpiry', header: 'Cargo ins. exp.', group: 'Insurance', text: (r) => dateText(policyExpiry(r, 'CARGO')), filter: 'date', dateOf: (r) => policyExpiry(r, 'CARGO') },
    { key: 'liabilityExpiry', header: 'Liability ins. exp.', group: 'Insurance', text: (r) => dateText(policyExpiry(r, 'AUTO_LIABILITY')), filter: 'date', dateOf: (r) => policyExpiry(r, 'AUTO_LIABILITY') },
    {
      key: 'authority',
      header: 'Authority',
      group: 'Compliance',
      text: (r) => (r.authorityStatus ? lower(r.authorityStatus) : ''),
      filter: 'multi',
      optionsOf: (r) => (r.authorityStatus ? single(r.authorityStatus, lower(r.authorityStatus)) : []),
    },
    {
      key: 'safety',
      header: 'Safety',
      group: 'Compliance',
      text: (r) => (r.safetyRating ? lower(r.safetyRating) : ''),
      filter: 'multi',
      optionsOf: (r) => (r.safetyRating ? single(r.safetyRating, lower(r.safetyRating)) : []),
    },
    {
      key: 'equipment',
      header: 'Equipment',
      group: 'Operations',
      text: (r) => (r.equipment ?? []).map(lower).join(', '),
      filter: 'multi',
      optionsOf: (r) => (r.equipment ?? []).map((code) => ({ value: code, label: lower(code) })),
    },
    {
      key: 'terms',
      header: 'Pay terms',
      group: 'Payment',
      text: (r) => (r.paymentTermsDays == null ? '' : `Net ${r.paymentTermsDays}`),
      filter: 'number',
      numberOf: (r) => r.paymentTermsDays ?? null,
      numberUnit: 'days',
    },
    {
      key: 'quickPay',
      header: 'Quick pay',
      group: 'Payment',
      text: (r) => (r.quickPayEligible ? (r.defaultQuickPayDays ? `${r.defaultQuickPayDays}d` : 'Yes') : ''),
      filter: 'multi',
      optionsOf: (r) => single(r.quickPayEligible ? 'Eligible' : 'No'),
    },
    {
      key: 'factor',
      header: 'Factor',
      group: 'Payment',
      text: (r) => (r.factorPaymentMethodId ? 'Factored' : 'Direct'),
      filter: 'multi',
      optionsOf: (r) => single(r.factorPaymentMethodId ? 'Factored' : 'Direct'),
    },
    { key: 'lastLoadAt', header: 'Last load', group: 'Operations', text: (r) => dateText(r.lastLoadAt), filter: 'date', dateOf: (r) => r.lastLoadAt ?? null },
    {
      key: 'loadCount',
      header: 'Loads',
      group: 'Operations',
      text: (r) => String(r.loadCount ?? 0),
      filter: 'number',
      numberOf: (r) => r.loadCount ?? 0,
      align: 'right',
    },
    { key: 'email', header: 'E-mail', group: 'Contact', text: (r) => r.email ?? '' },
    { key: 'phone', header: 'Phone', group: 'Contact', text: (r) => r.phone ?? '' },
    { key: 'dispatcher', header: 'Dispatcher', group: 'Contact', text: (r) => r.dispatcherName ?? '' },
    { key: 'cityState', header: 'City, state', group: 'Contact', text: cityState },
    {
      key: 'owner',
      header: 'Account owner',
      group: 'Account',
      text: (r) => (r.accountOwnerIds ?? []).join(', '),
      filter: 'multi',
      optionsOf: (r) => (r.accountOwnerIds ?? []).map((o) => ({ value: o, label: o })),
    },
  ]
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** CSV of every column for the rows on screen, in catalog order. */
export function carriersToCsv(rows: readonly CarrierRow[], columns: readonly DenseColumn<CarrierRow>[]): string {
  const header = columns.map((c) => csvCell(c.header)).join(',')
  const body = rows.map((row) => columns.map((c) => csvCell(c.text(row))).join(','))
  return [header, ...body].join('\n')
}
