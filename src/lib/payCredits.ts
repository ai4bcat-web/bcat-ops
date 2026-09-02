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

/**
 * Debit reasons — money taken OFF the check at 100%, after the % model has run.
 * Distinct from a deduction/expense: an after-expenses driver only bears their pay %
 * of an expense, but bears a debit dollar-for-dollar.
 */
export const DEBIT_REASONS: CreditReason[] = [
  { code: 'CASH_ADVANCE',   label: 'Cash advance',            hint: 'Money fronted to the driver, paid back off this check' },
  { code: 'DAMAGE',         label: 'Damage / claim',          hint: 'Cargo or equipment damage charged to the driver' },
  { code: 'ESCROW',         label: 'Escrow / reserve',        hint: 'Held back into the driver reserve account' },
  { code: 'OVERPAYMENT',    label: 'Overpayment recovery',    hint: 'Clawing back an amount overpaid on an earlier check' },
  { code: 'FINE',           label: 'Ticket / fine',           hint: 'Violation, citation or toll fine the company covered' },
  { code: 'PRIOR_PERIOD',   label: 'Prior-period adjustment', hint: 'Correcting an earlier settlement' },
  { code: 'OTHER',          label: 'Other',                   hint: 'Anything else — describe it in the note' },
]

export const DEFAULT_DEBIT_REASON = 'CASH_ADVANCE'

// One lookup for BOTH lists so a stored code always resolves to a label, whichever
// picker it came from (PRIOR_PERIOD/OTHER appear in both — same label, no conflict).
const BY_CODE = new Map([...CREDIT_REASONS, ...DEBIT_REASONS].map((r) => [r.code, r]))

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
