/**
 * Row classification and findings: what a mapped row IS (load, memo, junk), whether anything about
 * it blocks or skips it, which own-asset/division bucket it falls in, and its AR facts.
 * Pure; the engine owns what to do with the answers.
 */
import type { AljexRowKind, CanonicalRow } from './canonical'
import { normalizeLabel, type AljexProfile, type RevDivisionCode, type TypeMapEntry } from './profile'
import { mapStatus } from './status'
import { isDerivedPro } from '../proNumber'

export type RowClass = AljexRowKind | 'JUNK'

/** JUNK = no usable PRO at all (a blank/garbage line); everything else is its kind. */
export function classifyRow(row: CanonicalRow): RowClass {
  return row.pro === '' ? 'JUNK' : row.kind
}

export type FindingOutcome = 'blocking' | 'conflict' | 'error' | 'warning'

export interface RowFinding {
  code: string
  /** blocking = stops APPLY until mapped/accepted; conflict = row skipped and listed; error = row not applied; warning = note only. */
  outcome: FindingOutcome
  column?: string
}

export const MAX_PRO_LENGTH = 20

export interface FindingOptions {
  /** Configured shipment prefix, for the derived-shape guard (default `S`, the app's fallback). */
  shipmentPrefix?: string
}

export function rowFindings(row: CanonicalRow, profile: AljexProfile, opts: FindingOptions = {}): RowFinding[] {
  const out: RowFinding[] = []
  for (const e of row.errors) out.push({ code: e.code, outcome: 'error', ...(e.column ? { column: e.column } : {}) })
  for (const w of row.warnings) out.push({ code: w.code, outcome: 'warning', ...(w.column ? { column: w.column } : {}) })

  if (row.pro === '') return out
  if (row.pro.length > MAX_PRO_LENGTH) out.push({ code: 'OVERLONG_PRO', outcome: 'error' })
  else if (row.proKey == null) out.push({ code: 'INVALID_PRO', outcome: 'error' })
  else {
    if (!/^\d+$/.test(row.proKey)) out.push({ code: 'NON_NUMERIC_PRO', outcome: 'conflict' })
    if (isDerivedPro(row.pro, opts.shipmentPrefix ?? 'S')) out.push({ code: 'DERIVED_SHAPE', outcome: 'conflict' })
  }

  if (row.kind === 'LOAD') {
    if (row.statusKey === '') out.push({ code: 'BLANK_STATUS', outcome: 'blocking' })
    else if (!mapStatus(row.statusKey, profile)) out.push({ code: 'UNMAPPED_STATUS', outcome: 'blocking' })
    if (!(row.typeOfShipment in profile.typeMap)) out.push({ code: 'UNMAPPED_TYPE', outcome: 'blocking' })
    const status = mapStatus(row.statusKey, profile)
    if (status?.void && (row.money.invoiceAmountCents !== 0 || row.money.lhRevenueCents !== 0)) {
      out.push({ code: 'VOID_WITH_MONEY', outcome: 'conflict' })
    }
    if (hasInvoice(row) && row.customer.account === '') out.push({ code: 'INVOICE_NO_CUSTOMER', outcome: 'conflict' })
  }
  return out
}

/** Is this carrier name the own-asset carrier (Ivan Cartage) by the profile's match? */
export function isOwnAssetCarrier(name: string | null | undefined, profile: AljexProfile): boolean {
  const key = normalizeLabel(profile.ownAssetCarrierMatch)
  return key !== '' && normalizeLabel(name).includes(key)
}

/** The profile's type entry for the row, or null when unmapped. */
export function typeEntry(row: Pick<CanonicalRow, 'typeOfShipment'>, profile: AljexProfile): TypeMapEntry | null {
  return Object.prototype.hasOwnProperty.call(profile.typeMap, row.typeOfShipment) ? profile.typeMap[row.typeOfShipment] : null
}

/** Revenue division by the ordered `divisionRules`; first match wins. Memos are BROKERAGE. */
export function pickDivision(row: CanonicalRow, profile: AljexProfile): RevDivisionCode {
  if (row.kind !== 'LOAD') return 'BROKERAGE'
  for (const rule of profile.divisionRules) {
    switch (rule.when) {
      case 'ownAsset':
        if (isOwnAssetCarrier(row.carrier?.name, profile)) return rule.division
        break
      case 'typeCodes':
        if (rule.typeCodes?.includes(row.typeOfShipment)) return rule.division
        break
      case 'carrierIds': {
        const ids = rule.carrierIds?.length ? rule.carrierIds : profile.ownerOperatorCarrierIds
        if (row.carrier && ids.some((id) => id === row.carrier?.id || (row.carrier?.mc && id === row.carrier.mc))) return rule.division
        break
      }
      case 'default':
        return rule.division
    }
  }
  return 'BROKERAGE'
}

/** An invoice exists iff the load has an Invoice Date and a non-zero Invoice Amount (memos never do). */
export function hasInvoice(row: CanonicalRow): boolean {
  return row.kind === 'LOAD' && row.dates.invoice != null && row.money.invoiceAmountCents !== 0
}

export interface ArFacts {
  /** Invoice total: Invoice Amount + the net of the memo adjustment lines (CRED negative, DEBT positive). */
  totalCents: number
  /** Net memo adjustment included in `totalCents`. */
  adjustmentCents: number
  paymentsCents: number
  /** max(0, Bal Due): what stays open. */
  balanceCents: number
  /** Overpayment kept as customer credit: max(0, -Bal Due). */
  unappliedCents: number
  status: 'PAID' | 'PARTIAL' | 'ISSUED'
}

/**
 * AR facts of an invoiced load (DECIDED-1). CRED/DEBT memo rows are adjustment lines on the invoice
 * (`resolveMemos`), so they live in `total`, never in a separate credit. Bal Due stays authoritative
 * for the open balance; `balDueIdentityHolds` tells the engine whether the memos explain it.
 */
export function arFacts(row: CanonicalRow, adjustmentCents: number): ArFacts {
  const m = row.money
  const bal = m.balDueCents ?? 0
  const balanceCents = Math.max(0, bal)
  const totalCents = m.invoiceAmountCents + adjustmentCents
  const paymentsCents = m.paymentsReceivedCents
  const status = balanceCents === 0 ? 'PAID' : paymentsCents > 0 ? 'PARTIAL' : 'ISSUED'
  return { totalCents, adjustmentCents, paymentsCents, balanceCents, unappliedCents: Math.max(0, -bal), status }
}

/** Does Aljex's own Bal Due equal Invoice + memo adjustments - Payments? (Never trusted blindly.) */
export function balDueIdentityHolds(row: CanonicalRow, adjustmentCents: number): boolean {
  const m = row.money
  return m.balDueCents != null && m.balDueCents === m.invoiceAmountCents + adjustmentCents - m.paymentsReceivedCents
}

/** Exact-duplicate key: the trimmed cells with trailing blanks dropped (rows are right-truncated). */
export function rowSignature(cells: readonly string[]): string {
  let end = cells.length
  while (end > 0 && cells[end - 1].trim() === '') end--
  return cells.slice(0, end).map((c) => c.trim()).join('\u001f')
}
