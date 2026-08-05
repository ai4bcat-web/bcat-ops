/**
 * Reason codes for driver-pay credits — extra money added to a settlement check that
 * didn't come from a shipment's gross profit (detention, layover, bonuses, refunds of
 * an expense charged in error, prior-period corrections…).
 *
 * Codes are stored as plain strings on DriverPayCredit so this list can grow without a
 * backend redeploy; an unrecognised code still renders (falls back to the raw code).
 */

export interface CreditReason {
  code:  string
  label: string
  /** Shown under the picker so the office charges the right bucket. */
  hint?: string
}

export const CREDIT_REASONS: CreditReason[] = [
  { code: 'DETENTION',     label: 'Detention',              hint: 'Billed waiting time at a shipper/consignee' },
  { code: 'LAYOVER',       label: 'Layover',                hint: 'Overnight hold before the next appointment' },
  { code: 'TONU',          label: 'TONU',                   hint: 'Truck ordered, not used' },
  { code: 'EXTRA_STOP',    label: 'Extra stop',             hint: 'Stop-off added after dispatch' },
  { code: 'LUMPER',        label: 'Lumper / unloading',     hint: 'Driver paid a lumper out of pocket' },
  { code: 'TOLLS',         label: 'Tolls / permits',        hint: 'Out-of-pocket tolls, scales or permits' },
  { code: 'REIMBURSEMENT', label: 'Reimbursement',          hint: 'Any other out-of-pocket the driver fronted' },
  { code: 'BONUS',         label: 'Bonus',                  hint: 'Performance, safety or referral bonus' },
  { code: 'ADVANCE_REPAY', label: 'Expense reversal',       hint: 'Refund of a deduction charged in error' },
  { code: 'PRIOR_PERIOD',  label: 'Prior-period adjustment', hint: 'Correcting an earlier settlement' },
  { code: 'OTHER',         label: 'Other',                  hint: 'Anything else — describe it in the note' },
]

export const DEFAULT_CREDIT_REASON = 'DETENTION'

const BY_CODE = new Map(CREDIT_REASONS.map((r) => [r.code, r]))

export function creditReason(code?: string | null): CreditReason | undefined {
  return code ? BY_CODE.get(code) : undefined
}

/** Human label for a stored code — falls back to the raw code so nothing renders blank. */
export function creditReasonLabel(code?: string | null): string {
  return creditReason(code)?.label ?? (code || 'Credit')
}

/** The statement line for a credit: "Detention — Kroger 4hr wait" (note is optional). */
export function creditLineLabel(credit: { reasonCode?: string | null; label?: string | null }): string {
  const reason = creditReasonLabel(credit.reasonCode)
  const note = credit.label?.trim()
  return note ? `${reason} — ${note}` : reason
}
