/**
 * Approval state for driver pay credits.
 *
 * A credit added by someone other than the owner (e.g. Ruben on a box-truck check) is
 * PENDING until Ryne approves it; approved credits count toward the check, rejected ones
 * stay on the record for the audit trail but never pay out. Rows written before approval
 * existed have no status at all and are treated as approved, so nothing already paid moves.
 */
export type PayCreditApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export interface ApprovableCredit {
  kind?: string | null
  approvalStatus?: PayCreditApprovalStatus | string | null
}

/** Absent status = approved (legacy rows and owner-added credits). */
export function approvalStatusOf(c: ApprovableCredit): PayCreditApprovalStatus {
  return c.approvalStatus === 'PENDING' || c.approvalStatus === 'REJECTED' ? c.approvalStatus : 'APPROVED'
}

/** True when the row should be added to (or taken off) the check. */
export function creditCounts(c: ApprovableCredit): boolean {
  return approvalStatusOf(c) === 'APPROVED'
}

/**
 * What a freshly added credit starts as. Only the owner or an ADMIN can put money on a
 * check without a second pair of eyes; everyone else's credit waits for approval.
 * Debits never need approval — they only ever reduce a check.
 */
export function initialApprovalStatus(input: { kind?: 'CREDIT' | 'DEBIT' | null; canApprove: boolean }): PayCreditApprovalStatus {
  if (input.kind === 'DEBIT') return 'APPROVED'
  return input.canApprove ? 'APPROVED' : 'PENDING'
}

export function approvalLabel(status: PayCreditApprovalStatus): string {
  switch (status) {
    case 'PENDING': return 'Pending approval'
    case 'REJECTED': return 'Rejected'
    default: return 'Approved'
  }
}
